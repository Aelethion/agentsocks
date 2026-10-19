import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { root, sleep, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress } from "../src/envelope.ts";
import { codexIdentity, type Me } from "../src/peers.ts";
import { changeTask, createTask } from "../src/ops.ts";
import { sendMessage } from "../src/send.ts";
import type { Classifier, ClassifierInput } from "../src/classifier.ts";
import type { RouteSendResult } from "../src/routing.ts";

let calls: ClassifierInput[] = [];
let impl: Classifier["classify"] = async () => ({ route: "pause", confidence: 0.99 });
const classifier: Classifier = { name: "fake", remote: true, threshold: 0.6, timeoutMs: 400, classify: (input, signal) => (calls.push(input), impl(input, signal)) };
const broker = new Broker({ wakeEnabled: false, classifier: () => classifier });
const claude = (c: FakeClaude): Me => ({ kind: "claude", name: c.name, socketPath: c.socketPath, session: c.sessionId });
let receiver: FakeClaude;
let worker: Me;
const receivers: FakeClaude[] = [];

before(async () => {
  await broker.start();
  receiver = await fakeClaude("busy-receiver", livePid(), "busy");
  await broker.hook({ threadId: "thread-privacy", event: "SessionStart", cwd: "/work/privacy" });
  worker = await codexIdentity("thread-privacy");
});

after(async () => {
  for (const r of [receiver, ...receivers]) await closeServer(r.server);
  await broker.stop();
});

async function freshReceiver(name: string): Promise<FakeClaude> {
  const r = await fakeClaude(name, livePid(), "busy");
  receivers.push(r);
  return r;
}

const targetOf = (r: FakeClaude) => ({ kind: "claude", addr: encodeAddress(r.socketPath), name: r.name, sessionId: r.sessionId });
const from = () => ({ kind: worker.kind, name: worker.name, addr: encodeAddress(worker.socketPath!), session: worker.session ?? null, mode: null });

test("a task assignment and its notices are decided by rules alone and never reach the classifier", async () => {
  calls = [];
  const low = await createTask(worker, { to: "busy-receiver", title: "Rotate the staging credentials", details: "SECRET-TASK-DETAILS key id 42", acceptance: "new key live" });
  assert.deepEqual([low.delivery!.decision.by, low.delivery!.decision.route], ["default", "now"], "a normal task to a busy session is delivered at its next tool call");
  const high = await createTask(worker, { to: "busy-receiver", title: "Stop the deploy", details: "d", risk: "high" });
  assert.deepEqual([high.delivery!.decision.by, high.delivery!.decision.rule], ["rule", "urgent"], "risk high is urgent");
  await changeTask(claude(receiver), low.task.id, "accepted");
  const done = await changeTask(claude(receiver), low.task.id, "done", "SECRET-RESULT rotated", "SECRET-EVIDENCE commit abc1234");
  assert.equal(done.notified, true);
  assert.equal(calls.length, 0, `the classifier was called ${calls.length} times: ${JSON.stringify(calls).slice(0, 200)}`);
});

test("an ordinary message still reaches the classifier, and a made-up task id does not skip it", async () => {
  calls = [];
  const quiet = await freshReceiver("plain-receiver");
  const plain = await sendMessage(worker, "plain-receiver", "please look at the flaky test when you can");
  assert.equal(plain.route, "pause");
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]!).sort(), ["message", "receiverKind", "receiverTask"]);
  const forged = await broker.routeSend({ msgId: "forged-task-1", from: from(), to: targetOf(quiet), body: "an ordinary message dressed up as a task", urgency: "normal", taskId: "T-abcdef" });
  assert.equal(forged.decision.by, "classifier");
  assert.equal(calls.length, 2, "only a task that exists is exempt");
});

test("a prompt lookup that never finishes is cut off by the classifier's own timeout, and frees its slot", async () => {
  calls = [];
  const slow = await freshReceiver("slow-receiver");
  const transcripts = (broker as unknown as { transcripts: { latestPrompt(id: string): Promise<string | undefined> } }).transcripts;
  const real = transcripts.latestPrompt.bind(transcripts);
  transcripts.latestPrompt = () => new Promise(() => {});
  try {
    const started = Date.now();
    const result = await Promise.race([
      broker.routeSend({ msgId: "stuck-lookup-1", from: from(), to: targetOf(slow), body: "is the lookup bounded?", urgency: "normal" }),
      sleep(3000).then(() => "STILL WAITING" as const),
    ]);
    assert.notEqual(result, "STILL WAITING", "the send waited on the lookup");
    const decision = (result as RouteSendResult).decision;
    assert.equal(decision.route, "now");
    assert.match(decision.reason, /timed out after 400 ms/);
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
    assert.equal((broker as unknown as { classifying: number }).classifying, 0, "the slot is free again");
    assert.equal(calls.length, 0, "the classifier was never called without its input");
  } finally {
    transcripts.latestPrompt = real;
  }
});

test("a FIFO standing in for the receiver's transcript does not stall a send", async () => {
  calls = [];
  const piped = await freshReceiver("piped-receiver");
  const dir = join(process.env.AGENTSOCKS_CLAUDE_PROJECTS_DIR!, "-work-piped-receiver");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${piped.sessionId}.jsonl`);
  rmSync(path, { force: true });
  execFileSync("mkfifo", [path]);
  try {
    const started = Date.now();
    const result = await Promise.race([
      broker.routeSend({ msgId: "fifo-transcript-1", from: from(), to: targetOf(piped), body: "does a pipe block me?", urgency: "normal" }),
      sleep(3000).then(() => "STILL WAITING" as const),
    ]);
    assert.notEqual(result, "STILL WAITING");
    assert.equal((result as RouteSendResult).decision.by, "classifier");
    assert.ok(Date.now() - started < 1500);
    assert.equal(calls[0]!.receiverTask, `session ${piped.name} in /work/${piped.name}`, "without a readable transcript the classifier gets the session label");
  } finally {
    rmSync(path, { force: true });
  }
});
