import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { root, sleep, until, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { brokerCall } from "../src/client.ts";
import { encodeAddress, messageContent, parseEnvelope } from "../src/envelope.ts";
import { canonicalPath } from "../src/paths.ts";
import { changeTask, createTask, getTask, listTasks, messageStatus, peerStatus } from "../src/ops.ts";
import { codexIdentity, type Me } from "../src/peers.ts";
import { redactSecrets } from "../src/redact.ts";
import { sendMessage } from "../src/send.ts";
import { formatPeerStatus } from "../src/render.ts";
import type { Classifier, ClassifierInput } from "../src/classifier.ts";
import type { PeerStatus } from "../src/status.ts";
import type { TaskRow } from "../src/store.ts";
import { cat, GITHUB_PAT_LOWER, GITHUB_OAUTH, GITLAB_PAT } from "./fakes.ts";

let seenByClassifier: ClassifierInput[] = [];
let classifier: Classifier | undefined;
const broker = new Broker({ wakeEnabled: false, classifier: () => classifier });
const claude = (c: FakeClaude): Me => ({ kind: "claude", name: c.name, socketPath: c.socketPath, session: c.sessionId });
const rpc = <T>(op: string, args: Record<string, unknown>) => brokerCall<T>(op, args, { autoStart: false });
const partyOf = (me: Me) => ({ kind: me.kind, name: me.name, addr: me.socketPath ? encodeAddress(me.socketPath) : null, session: me.session ?? null, mode: null });

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("tasks are listed for a caller, and a task or message is only read by the people it concerns", async () => {
  const bob = await fakeClaude("bob", livePid(), "idle");
  try {
    const alice = await codexIdentity("alice-thread", "/work/alice");
    const eve = await codexIdentity("eve-thread", "/work/eve");
    const { task, delivery } = await createTask(alice, { to: "bob", title: "rotate the prod key", details: "SECRET-DETAILS-FOR-BOB: key id 42", acceptance: "new key live", risk: "high" });

    const anonymous: Me = { kind: "cli", name: "claude-unregistered" };
    await assert.rejects(listTasks(anonymous, "all", true), /tasks are listed for a session/);
    await assert.rejects(rpc("task_list", { status: "all" }), /tasks are listed for a session/);
    assert.deepEqual((await listTasks(eve, "all", true)).map((t) => t.id), [], "a third session sees nothing");
    assert.deepEqual((await listTasks(alice, "created_by_me", false)).map((t) => t.id), [task.id]);
    assert.deepEqual((await listTasks(claude(bob), "assigned_to_me", false)).map((t) => t.id), [task.id]);

    await assert.rejects(getTask(eve, task.id), /no task .* created by or assigned to you/);
    assert.equal((await getTask(alice, task.id)).title, "rotate the prod key");
    assert.equal((await getTask(claude(bob), task.id)).id, task.id);

    await assert.rejects(messageStatus(eve, delivery!.msgId), /no message .* sent or received by you/);
    assert.equal((await messageStatus(alice, delivery!.msgId)).msg_id, delivery!.msgId);
    assert.equal((await messageStatus(claude(bob), delivery!.msgId)).msg_id, delivery!.msgId);
    await assert.rejects(changeTask(eve, task.id, "cancelled"), /only the assignee or the creator/);

    const shell: Me = { kind: "cli", name: "cli-project" };
    const fromShell = await sendMessage(shell, "bob", "a note from the shell");
    assert.equal((await messageStatus(shell, fromShell.msgId)).msg_id, fromShell.msgId, "a shell sees the messages it sent");
    await assert.rejects(messageStatus({ kind: "cli", name: "cli-other" }, fromShell.msgId), /no message/);
  } finally {
    await closeServer(bob.server);
  }
});

test("task_list clamps its limit to 1..500", async () => {
  const lead = await fakeClaude("limitlead", livePid(), "idle");
  try {
    const now = Date.now();
    for (let i = 0; i < 520; i++) {
      broker.store.insertTask({
        id: `T-${i.toString(16).padStart(6, "0")}`, from_addr: encodeAddress(canonicalPath(lead.socketPath)), from_name: "limitlead", to_addr: "uds:/x", to_name: "x", to_kind: "codex", title: "t", body: "b", acceptance: null, risk: "low",
        external_ref: null, on_behalf_of: null, status: "open", result: null, evidence: null, from_session: lead.sessionId, to_session: null, request_id: null, created_at: now + i, updated_at: now, expires_at: now + 1e9,
      });
    }
    const party = encodeAddress(lead.socketPath);
    assert.equal((await rpc<TaskRow[]>("task_list", { party, limit: 100_000 })).length, 500);
    assert.equal((await rpc<TaskRow[]>("task_list", { party, limit: -5 })).length, 1);
    assert.equal((await rpc<TaskRow[]>("task_list", { party })).length, 50);
  } finally {
    await closeServer(lead.server);
  }
});

test("prompts are redacted before storage, cut to 200 characters, shown to peers at 100, and the classifier gets the redacted text", async () => {
  await broker.hook({ threadId: "victim-thread", event: "SessionStart", cwd: "/work/victim" });
  await broker.hook({ threadId: "victim-thread", event: "UserPromptSubmit", prompt: `deploy with token ghp_SECRETSECRETSECRET1234567890 to the prod cluster and email the board ${"and then keep going ".repeat(12)}` });
  const stored = broker.store.getThread("victim-thread")!.current_task!;
  assert.ok(!stored.includes("ghp_"), stored);
  assert.ok(stored.startsWith("deploy with token [redacted] to the prod cluster"));
  assert.ok(stored.length <= 200);
  const other = await codexIdentity("other-thread", "/work/other");
  const status = await peerStatus(other, "victim-thread");
  assert.ok(status.actual.currentTask!.length <= 100);
  assert.ok(!formatPeerStatus(status).includes("ghp_"));

  seenByClassifier = [];
  classifier = { name: "spy", remote: false, threshold: 0.6, timeoutMs: 500, async classify(input) { seenByClassifier.push(input); return { route: "pause", confidence: 0.9 }; } };
  const lead = await fakeClaude("classifylead", livePid(), "idle");
  try {
    await broker.hook({ threadId: "victim-thread", event: "UserPromptSubmit", prompt: "rotate the key with password=hunter2 now" });
    await sendMessage(claude(lead), "codex-victim", "please use Bearer abcdefghijklmnop123456 for the call");
    assert.equal(seenByClassifier.length, 1);
    assert.ok(!JSON.stringify(seenByClassifier[0]).includes("hunter2") && !JSON.stringify(seenByClassifier[0]).includes("abcdefghijklmnop123456"));
  } finally {
    classifier = undefined;
    await closeServer(lead.server);
  }
});

test("the redaction table", () => {
  const cases: [string, string][] = [
    [`${GITHUB_PAT_LOWER} and ${GITHUB_OAUTH}`, "[redacted] and [redacted]"],
    [cat("github", "_pat_11AAAAAAA0abcdefghijklmnop_QRSTUVWXYZ"), "[redacted]"],
    [cat("use sk-ant", "-api03-abcdefghijklmnop here"), "use [redacted] here"],
    [cat("xox", "b-123456789012-abcdefghij xox", "p-1234567890-abcdef12"), "[redacted] [redacted]"],
    [cat("AKIA", "IOSFODNN7EXAMPLE and AIza", "SyA-abcdefghijklmnopqrstuvwxyz0123456"), "[redacted] and [redacted]"],
    [GITLAB_PAT, "[redacted]"],
    [cat("Authorization: Bearer ey", "JhbGciOiJIUzI1NiJ9.payload.sig"), "Authorization: [redacted]"],
    ['password="correct horse battery" token=abc123 secret: s3cr3t api_key=k', "password=[redacted] token=[redacted] secret: [redacted] api_key=[redacted]"],
    ["a0b1c2d3e4f5a0b1c2d3e4f5a0b1c2d3e4f5a0b1 is a sha", "a0b1c2d3e4f5a0b1c2d3e4f5a0b1c2d3e4f5a0b1 is a sha"],
    ["fix the flaky checkout test in src/cart.ts", "fix the flaky checkout test in src/cart.ts"],
  ];
  for (const [input, want] of cases) assert.equal(redactSecrets(input), want, input);
});

test("a registry session id that is not a plain id is dropped before it can name a file", async () => {
  mkdirSync(join(root, "claude-projects", "proj"), { recursive: true });
  const sock = join(root, "cc-socks", "traversal.sock");
  const { serveInbox } = await import("../src/ccsocks.ts");
  const frames: unknown[] = [];
  const server = await serveInbox(sock, (f) => frames.push(f));
  const pid = livePid();
  writeFileSync(join(root, "claude-sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: "../../outside-projects", cwd: "/w/v", name: "traversal", messagingSocketPath: sock, kind: "interactive", status: "idle" }));
  const outside = join(root, "outside-projects.jsonl");
  writeFileSync(outside, "");
  try {
    const sent = await sendMessage({ kind: "cli", name: "cli-x" }, "traversal", "hello");
    await until(() => frames.length === 1);
    assert.equal(broker.store.getOutbox(sent.msgId)!.to_session, null, "the id was not trusted");
    appendFileSync(outside, `${JSON.stringify({ type: "user", origin: { kind: "peer", msg_id: sent.msgId } })}\n`);
    await broker.runSweep();
    assert.equal(broker.store.getOutbox(sent.msgId)!.status, "sent", "a file outside the projects directory proves nothing");
  } finally {
    await closeServer(server);
  }
});

test("tasks follow a Claude session across a restart: listed under its session id, and notices find its new socket", async () => {
  const worker = await codexIdentity("restart-worker", "/work/restart");
  const before = await fakeClaude("phoenix", livePid(), "idle");
  const created = await createTask(claude(before), { to: "codex-restart", title: "Ship the fix", details: "details" });
  await closeServer(before.server);
  const after = await fakeClaude("phoenix", livePid(), "idle");
  assert.notEqual(after.socketPath, before.socketPath, "a restarted session has a new socket");
  assert.equal(after.sessionId, before.sessionId);

  const listed = await listTasks(claude(after), "created_by_me", false);
  assert.deepEqual(listed.map((t) => t.id), [created.task.id], "listed by session id although the address changed");
  const done = await changeTask(worker, created.task.id, "done", "shipped", "commit abc");
  assert.equal(done.notified, true);
  const notice = await until(() => after.frames.find((f) => parseEnvelope(messageContent(f))?.body.includes(`${created.task.id}] Ship the fix: done`)));
  assert.ok(notice, "the notice went to the new socket");
  await closeServer(after.server);
});

test("concurrent first registrations of one thread all succeed", async () => {
  const outcomes = await Promise.allSettled([broker.register("race-thread", {}), broker.register("race-thread", {}), broker.register("race-thread", {})]);
  assert.deepEqual(outcomes.map((o) => o.status), ["fulfilled", "fulfilled", "fulfilled"]);
  const mixed = await Promise.allSettled([broker.hook({ threadId: "race-two", event: "SessionStart", cwd: "/w" }), broker.register("race-two", {}), broker.hook({ threadId: "race-two", event: "UserPromptSubmit", prompt: "x" })]);
  assert.deepEqual(mixed.map((o) => o.status), ["fulfilled", "fulfilled", "fulfilled"]);
  await sleep(20);
});
