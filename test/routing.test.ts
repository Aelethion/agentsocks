import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { root, wakeLog, sleep, until, fakeClaude, inTranscript, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer, postLines } from "../src/ccsocks.ts";
import { buildEnvelope, encodeAddress, messageContent, parseEnvelope } from "../src/envelope.ts";
import { codexIdentity } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";
import { peerStatus } from "../src/ops.ts";
import { formatPeerStatus } from "../src/render.ts";
import { auditLogPath } from "../src/paths.ts";
import type { Me } from "../src/peers.ts";
import type { Classifier, ClassifierInput, ClassifierResult } from "../src/classifier.ts";
import type { OutboxRow } from "../src/store.ts";
import { tempDir } from "./tmp.ts";

let classifierImpl: Classifier | undefined;
const classifierCalls: ClassifierInput[] = [];
const broker = new Broker({ classifier: () => classifierImpl });

let alpha: FakeClaude;
let beta: FakeClaude;
const orchestrator: Me = { kind: "claude", name: "orchestrator", socketPath: join(root, "cc-socks", "orch.sock"), session: "orch-session" };

const outbox = (msgId: string): OutboxRow => broker.store.getOutbox(msgId)!;
const paused = (ms: number) => sleep(ms);

before(async () => {
  await broker.start();
  alpha = await fakeClaude("alpha", process.pid, "busy");
  beta = await fakeClaude("beta", process.ppid, "idle");
});

after(async () => {
  await closeServer(alpha.server);
  await closeServer(beta.server);
  await broker.stop();
});

const fakeClassifier = (answer: () => Promise<ClassifierResult>, over: Partial<Classifier> = {}): Classifier => ({
  name: "fake",
  remote: false,
  threshold: 0.6,
  timeoutMs: 80,
  classify: (input) => {
    classifierCalls.push(input);
    return answer();
  },
  ...over,
});

const framesFor = (c: FakeClaude, since = 0) => c.frames.slice(since);
const priorities = (c: FakeClaude) => c.frames.map((f) => f.priority);

test("Claude target: idle and busy receivers both get priority next by default; fyi is held; urgent goes next; never priority now", async () => {
  const me = await codexIdentity("thread-sender-1", "/work/sender");
  beta.setStatus("idle");
  const idle = await sendMessage(me, "beta", "build finished");
  assert.equal(idle.route, "now");
  await until(() => framesFor(beta).length === 1);
  assert.equal(framesFor(beta)[0]!.priority, "next");

  alpha.setStatus("busy");
  const normal = await sendMessage(me, "alpha", "could you review PR 12 when you can");
  assert.equal(normal.route, "now", "a busy receiver is interrupted at its next tool call unless the budget or a classifier says otherwise");
  await until(() => framesFor(alpha).length === 1);
  assert.equal(framesFor(alpha)[0]!.priority, "next");
  assert.equal(outbox(normal.msgId).status, "sent");
  assert.match(JSON.parse(outbox(normal.msgId).decision).reason, /no classifier/);

  const real = await sendMessage(me, "alpha", "main is red, stop pushing", undefined, { urgency: "urgent" });
  assert.equal(real.route, "now");
  await until(() => framesFor(alpha).length === 2);
  assert.equal(framesFor(alpha)[1]!.priority, "next");

  const fyi = await sendMessage(me, "alpha", "FYI renamed docs/guide to docs/handbook", undefined, { urgency: "fyi" });
  assert.equal(fyi.route, "digest");
  await paused(150);
  assert.equal(framesFor(alpha).length, 2, "a digest is held, not posted");
  assert.deepEqual([outbox(fyi.msgId).status, outbox(fyi.msgId).sent_at], ["held", null]);

  for (const c of [alpha, beta]) assert.ok(!priorities(c).includes("now"), "priority now (abort the running turn) is never used");
});

test("the envelope a Claude receiver sees keeps the sender's identity, reply address and honest mode", async () => {
  const me = await codexIdentity("thread-sender-1");
  const before = framesFor(beta).length;
  await sendMessage(me, "beta", "who are you");
  const frame = await until(() => framesFor(beta)[before]);
  const env = parseEnvelope(messageContent(frame));
  assert.ok(env, "the envelope must round-trip through the Claude parser");
  assert.equal(env!.from, encodeAddress(me.socketPath!));
  assert.equal(env!.fromName, `${me.name} (codex)`);
  assert.equal(env!.fromSession, "thread-sender-1");
  assert.equal(env!.body, "who are you");
});

test("the same text sent twice within ten minutes is recorded once and delivered once (merge)", async () => {
  const me = await codexIdentity("thread-sender-1");
  beta.setStatus("busy");
  const before = framesFor(beta).length;
  const first = await sendMessage(me, "beta", "please rebase onto main");
  const second = await sendMessage(me, "beta", "please   rebase\nonto main ");
  assert.equal(first.route, "now");
  assert.equal(second.route, "merge");
  assert.equal(second.delivered, false);
  assert.match(second.note, /^Not sent again: you sent the same text to them in the last 10 minutes\.$/);
  await paused(150);
  assert.equal(framesFor(beta).length, before + 1);
  assert.equal(outbox(second.msgId).status, "merged");
  const other = await sendMessage(me, "beta", "a different message");
  assert.notEqual(other.route, "merge");
});

test("a sender that has sent ten messages in ten minutes has the rest batched; the first three interrupt and the rest wait for the turn end", async () => {
  const flooder: Me = { kind: "claude", name: "flooder", socketPath: join(root, "cc-socks", "flood.sock"), session: "flood-session" };
  const delta = await fakeClaude("delta", livePid(), "busy");
  try {
    const routes: string[] = [];
    for (let i = 0; i < 12; i++) routes.push((await sendMessage(flooder, "delta", `distinct message ${i}`)).route!);
    assert.deepEqual(routes, [...Array(3).fill("now"), ...Array(7).fill("pause"), "digest", "digest"]);
    const row = broker.store.db.prepare("SELECT decision FROM outbox WHERE body = 'distinct message 11'").get() as { decision: string };
    assert.deepEqual([JSON.parse(row.decision).by, JSON.parse(row.decision).rule], ["budget", "sender-budget"]);
  } finally {
    await closeServer(delta.server);
  }
});

test("a receiver is interrupted at most three times by ordinary messages and six by urgent ones in ten minutes; idle time and awaited replies do not use the budget", async () => {
  const caller: Me = { kind: "claude", name: "caller", socketPath: join(root, "cc-socks", "caller.sock"), session: "caller-session" };
  const gamma = await fakeClaude("gamma", livePid(), "busy");
  try {
    const sent = [];
    for (let i = 0; i < 5; i++) sent.push(await sendMessage(caller, "gamma", `ordinary ${i}`));
    assert.deepEqual(sent.map((r) => r.route), ["now", "now", "now", "pause", "pause"]);
    assert.equal(JSON.parse(outbox(sent[4]!.msgId).decision).rule, "receiver-budget");
    await until(() => gamma.frames.length === 5);
    assert.deepEqual(priorities(gamma), ["next", "next", "next", "later", "later"]);
    const urgent: string[] = [];
    for (let i = 0; i < 4; i++) urgent.push((await sendMessage(caller, "gamma", `urgent ${i}`, undefined, { urgency: "urgent" })).route!);
    assert.deepEqual(urgent, ["now", "now", "now", "pause"], "urgent messages have a budget of six, three already used");
    gamma.setStatus("idle");
    assert.equal((await sendMessage(caller, "gamma", "idle one")).route, "now", "an idle receiver is never budget limited");
  } finally {
    await closeServer(gamma.server);
  }
});

test("Codex target: a paused message is not announced mid-turn, blocks Stop once, and a digest is invisible until the turn ends or the thread reads", async () => {
  await broker.hook({ threadId: "thread-codex-1", event: "SessionStart", cwd: "/work/codex1" });
  await broker.hook({ threadId: "thread-codex-1", event: "UserPromptSubmit", prompt: "refactor the auth middleware" });
  classifierImpl = fakeClassifier(() => Promise.resolve({ route: "pause", confidence: 0.9 }));
  const askPause = await sendMessage(orchestrator, "codex1", "can you review the schema change when done");
  classifierImpl = undefined;
  assert.equal(askPause.route, "pause");
  const askDigest = await sendMessage(orchestrator, "codex1", "FYI lint is green on my side", undefined, { urgency: "fyi" });
  assert.equal(askDigest.route, "digest");
  assert.equal(broker.store.queuedCount("thread-codex-1"), 1, "the digest is not in the unread inbox");

  const mid = await broker.hook({ threadId: "thread-codex-1", event: "PostToolUse", toolName: "Edit" });
  assert.equal(mid.context, undefined, "pause is not announced between tool calls");
  const stop = await broker.hook({ threadId: "thread-codex-1", event: "Stop" });
  assert.ok(stop.block?.includes("before you finish"), "pause blocks Stop once");
  assert.ok(!stop.block?.includes("FYI lint"), "no peer text in the notice");
  assert.equal(broker.store.queuedCount("thread-codex-1"), 1, "the digest is still held while the turn continues");
  assert.equal(outbox(askPause.msgId).status, "sent", "queued is not shown");
  await broker.hook({ threadId: "thread-codex-1", event: "UserPromptSubmit", prompt: "carry on" });
  const text = broker.take("thread-codex-1").text;
  assert.equal(outbox(askPause.msgId).status, "shown", "an acknowledged read marks it shown");
  assert.equal(outbox(askDigest.msgId).status, "shown", "a reader gets its held digests too");
  assert.ok(text.includes("can you review the schema change"));
  assert.ok(text.includes("FYI lint is green"));
});

test("Codex digests are released to a thread that stops its turn", async () => {
  await broker.hook({ threadId: "thread-codex-4", event: "SessionStart", cwd: "/work/codex4" });
  await broker.hook({ threadId: "thread-codex-4", event: "UserPromptSubmit", prompt: "long task" });
  const digest = await sendMessage(orchestrator, "codex4", "FYI the dataset moved", undefined, { urgency: "fyi" });
  assert.equal(outbox(digest.msgId).status, "held");
  const end = await broker.hook({ threadId: "thread-codex-4", event: "Stop" });
  assert.equal(end.block, undefined, "a digest never blocks Stop");
  assert.equal(outbox(digest.msgId).status, "sent", "the digest is released when the thread goes idle");
  assert.equal(broker.store.queuedCount("thread-codex-4"), 1);
  assert.ok(broker.take("thread-codex-4").text.includes("the dataset moved"));
});

test("Codex hooks remember the task, the last tool and the last activity; a wake line is not a task", async () => {
  await broker.hook({ threadId: "thread-codex-2", event: "SessionStart", cwd: "/work/codex2" });
  const prompt = `${"fix the flaky checkout test ".repeat(40)}`;
  await broker.hook({ threadId: "thread-codex-2", event: "UserPromptSubmit", prompt });
  let t = broker.store.getThread("thread-codex-2")!;
  assert.equal(t.current_task, prompt.trim().slice(0, 200), "at most 200 characters of the prompt are kept");
  assert.equal(t.last_tool, null);
  const first = t.last_activity!;
  assert.ok(first > 0);
  await sleep(5);
  await broker.hook({ threadId: "thread-codex-2", event: "PostToolUse", toolName: "apply_patch" });
  t = broker.store.getThread("thread-codex-2")!;
  assert.equal(t.last_tool, "apply_patch");
  assert.ok(t.last_activity! > first);
  await broker.hook({ threadId: "thread-codex-2", event: "UserPromptSubmit", prompt: "📨 agentsocks: new message from a Claude Code session. Read it with read_inbox." });
  assert.equal(broker.store.getThread("thread-codex-2")!.current_task, prompt.trim().slice(0, 200), "the wake line leaves the task alone");
  await broker.hook({ threadId: "thread-codex-2", event: "UserPromptSubmit", prompt: "now rename the module" });
  t = broker.store.getThread("thread-codex-2")!;
  assert.deepEqual([t.current_task, t.last_tool], ["now rename the module", null]);
});

test("a frame that arrives from outside agentsocks is routed too: a busy Codex thread takes it now, an awaited reply is exempt from the budget", async () => {
  await broker.hook({ threadId: "thread-codex-3", event: "SessionStart", cwd: "/work/codex3" });
  await broker.hook({ threadId: "thread-codex-3", event: "UserPromptSubmit", prompt: "migrate the users table" });
  const sock = join(process.env.AGENTSOCKS_RUNTIME_DIR!, "t", "thread-codex-3.sock");
  const post = (from: FakeClaude, body: string, id: string) =>
    postLines(sock, [JSON.stringify({ type: "user", message: { role: "user", content: buildEnvelope({ from: encodeAddress(from.socketPath), fromName: from.name, body }) }, priority: "next", msg_id: id })]);
  await post(alpha, "thoughts on the naming?", "raw-1");
  await until(() => broker.store.queuedCount("thread-codex-3") === 1);
  const row = broker.store.db.prepare("SELECT route, decision FROM messages WHERE msg_id = 'raw-1'").get() as { route: string; decision: string };
  assert.equal(row.route, "now");
  assert.equal(JSON.parse(row.decision).by, "default");
  assert.ok((await broker.hook({ threadId: "thread-codex-3", event: "PostToolUse" })).context, "a grey-zone frame is announced at the next tool call");

  const codex3 = await codexIdentity("thread-codex-3");
  const asked = await sendMessage(codex3, "alpha", "which schema version should I target?");
  inTranscript(alpha, asked.msgId);
  await post(alpha, "target version 7", "raw-2");
  await until(() => broker.store.queuedCount("thread-codex-3") === 2);
  const reply = broker.store.db.prepare("SELECT route, decision FROM messages WHERE msg_id = 'raw-2'").get() as { route: string; decision: string };
  assert.equal(reply.route, "now");
  assert.equal(JSON.parse(reply.decision).rule, "awaited-reply");
  await until(() => outbox(asked.msgId).status === "replied");
  assert.ok(outbox(asked.msgId).replied_at! >= outbox(asked.msgId).created_at);
  const mid = await broker.hook({ threadId: "thread-codex-3", event: "PostToolUse" });
  assert.ok(mid.context?.includes("new message"), "the awaited reply is announced between tool calls");
});

test("a routed reply marks the question it answers, in either direction", async () => {
  const codex1 = await codexIdentity("thread-codex-1");
  beta.setStatus("busy");
  const question = await sendMessage(codex1, "beta", "does the migration need a lock?");
  assert.equal(outbox(question.msgId).status, "sent");
  inTranscript(beta, question.msgId);
  const betaMe: Me = { kind: "claude", name: "beta", socketPath: beta.socketPath, session: beta.sessionId };
  const answer = await sendMessage(betaMe, "codex1", "no lock needed");
  assert.equal(answer.route, "now", "the awaited answer reaches the asker at once");
  assert.equal(outbox(question.msgId).status, "replied");
  assert.ok(broker.take("thread-codex-1").text.includes("no lock needed"));
});

test("the classifier decides only the grey zone, sees the receiver's session, and its failure falls back to the default", async () => {
  const caller: Me = { kind: "claude", name: "classy", socketPath: join(root, "cc-socks", "classy.sock"), session: "classy-session" };
  const epsilon = await fakeClaude("epsilon", livePid(), "busy");
  try {
    classifierImpl = fakeClassifier(() => Promise.resolve({ route: "now", confidence: 0.92 }));
    const r = await sendMessage(caller, "epsilon", "the staging credentials were rotated, do not deploy");
    assert.equal(r.route, "now");
    const decision = JSON.parse(outbox(r.msgId).decision);
    assert.deepEqual([decision.by, decision.backend, decision.confidence], ["classifier", "fake", 0.92]);
    await until(() => epsilon.frames.length === 1);
    assert.equal(epsilon.frames[0]!.priority, "next");
    assert.equal(classifierCalls.at(-1)!.receiverKind, "claude");
    assert.match(classifierCalls.at(-1)!.receiverTask!, /epsilon.* in \/work\/epsilon/, "the classifier sees the Claude session's name and working directory, nothing more");

    classifierImpl = fakeClassifier(() => Promise.resolve({ route: "pause", confidence: 0.9 }));
    const waits = await sendMessage(caller, "epsilon", "could you also rename the helper");
    assert.equal(waits.route, "pause");
    await until(() => epsilon.frames.length === 2);
    assert.equal(epsilon.frames[1]!.priority, "later", "a classifier pause is posted at priority later");

    classifierImpl = fakeClassifier(() => new Promise(() => {}));
    const slow = await sendMessage(caller, "epsilon", "this classifier never answers");
    assert.equal(slow.route, "now", "a classifier that fails or times out leaves the default route");
    assert.match(JSON.parse(outbox(slow.msgId).decision).reason, /timed out/);

    const calls = classifierCalls.length;
    classifierImpl = fakeClassifier(() => Promise.resolve({ route: "now", confidence: 0.99 }));
    beta.setStatus("idle");
    assert.equal((await sendMessage(caller, "beta", "to an idle receiver")).route, "now");
    assert.equal((await sendMessage(caller, "epsilon", "just fyi", undefined, { urgency: "fyi" })).route, "digest");
    assert.equal(classifierCalls.length, calls, "no classifier call when a rule decides");
  } finally {
    classifierImpl = undefined;
    await closeServer(epsilon.server);
  }
});

test("when the broker cannot take the send, the message is posted directly and the result says so", async () => {
  const dir = tempDir("agentsocks-oldbroker-");
  const old = createServer((s) => {
    s.on("data", () => s.end(`${JSON.stringify({ id: 1, ok: false, error: "unknown op route_send" })}\n`));
  });
  await new Promise<void>((r) => old.listen(join(dir, "broker.sock"), () => r()));
  const saved = process.env.AGENTSOCKS_RUNTIME_DIR;
  process.env.AGENTSOCKS_RUNTIME_DIR = dir;
  try {
    beta.setStatus("idle");
    const before = framesFor(beta).length;
    const r = await sendMessage(orchestrator, "beta", "sent while the broker is old");
    assert.match(r.note, /older version/);
    assert.equal(r.route, undefined);
    const frame = await until(() => framesFor(beta)[before]);
    assert.equal(frame.priority, "next");
    assert.equal(parseEnvelope(messageContent(frame))!.body, "sent while the broker is old");
  } finally {
    process.env.AGENTSOCKS_RUNTIME_DIR = saved;
    old.close();
  }
});

test("sending to a Claude session that has gone away fails cleanly and leaves no outbox row", async () => {
  mkdirSync(join(root, "cc-socks"), { recursive: true });
  const rows = Number((broker.store.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n);
  await assert.rejects(sendMessage(orchestrator, "uds:" + join(root, "cc-socks", "ghost.sock"), "anyone there?"), /no inbox socket/);
  assert.equal(Number((broker.store.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n), rows);
});

test("the classifier is shown a Claude receiver's latest typed prompt, redacted, and that text is neither stored, logged nor shown by peer_status", async () => {
  const zeta = await fakeClaude("zeta", livePid(), "busy");
  const projectDir = join(process.env.AGENTSOCKS_CLAUDE_PROJECTS_DIR!, "-work-zeta");
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${zeta.sessionId}.jsonl`);
  const user = (content: unknown, extra: Record<string, unknown> = {}) => `${JSON.stringify({ type: "user", message: { role: "user", content }, ...extra })}\n`;
  try {
    appendFileSync(transcript, user("an older request about something else") + user("Refactor the invoice exporter, secret=Zq8xLm2Pa9 stays out, PROMPTMARK-7f3a"));
    classifierImpl = fakeClassifier(() => Promise.resolve({ route: "now", confidence: 0.92 }));
    await sendMessage(orchestrator, "zeta", "the staging credentials were rotated");
    const first = classifierCalls.at(-1)!;
    assert.equal(first.receiverKind, "claude");
    assert.match(first.receiverTask!, /^Refactor the invoice exporter, secret=\[redacted\] stays out, PROMPTMARK-7f3a$/);

    appendFileSync(transcript, user([{ type: "tool_result", tool_use_id: "t1", content: "a big tool output" }]) + user("meta", { isMeta: true }) + user("a peer said hello", { origin: { kind: "peer", msg_id: "m-ignored" } }));
    await sendMessage(orchestrator, "zeta", "another grey-zone message");
    assert.match(classifierCalls.at(-1)!.receiverTask!, /^Refactor the invoice exporter/, "tool results, meta lines and peer messages do not replace the prompt");

    appendFileSync(transcript, user("Now write the migration for the new tenant_id column"));
    await sendMessage(orchestrator, "zeta", "a third grey-zone message");
    assert.equal(classifierCalls.at(-1)!.receiverTask, "Now write the migration for the new tenant_id column");

    const stored = JSON.stringify(broker.store.db.prepare("SELECT * FROM outbox").all()) + JSON.stringify(broker.store.db.prepare("SELECT * FROM messages").all());
    const audit = existsSync(auditLogPath()) ? readFileSync(auditLogPath(), "utf8") : "";
    const shown = formatPeerStatus(await peerStatus(orchestrator, "zeta"));
    for (const [where, text] of [["the database", stored], ["the audit log", audit], ["peer_status", shown]] as const) {
      assert.ok(!text.includes("PROMPTMARK") && !text.includes("tenant_id column") && !text.includes("invoice exporter"), `${where} holds no prompt text`);
    }
    assert.ok(!audit.includes("Zq8xLm2Pa9"));
  } finally {
    classifierImpl = undefined;
    await closeServer(zeta.server);
  }
});

test("a Claude receiver with no readable transcript keeps the session label as its task", async () => {
  const eta = await fakeClaude("eta", livePid(), "busy");
  try {
    classifierImpl = fakeClassifier(() => Promise.resolve({ route: "now", confidence: 0.92 }));
    await sendMessage(orchestrator, "eta", "no transcript exists for this session");
    assert.match(classifierCalls.at(-1)!.receiverTask!, /^session eta in \/work\/eta$/);
  } finally {
    classifierImpl = undefined;
    await closeServer(eta.server);
  }
});

test("a transcript that cannot be read as a file leaves the session label, and the message is still classified and sent", async () => {
  const theta = await fakeClaude("theta", livePid(), "busy");
  mkdirSync(join(process.env.AGENTSOCKS_CLAUDE_PROJECTS_DIR!, "-work-theta", `${theta.sessionId}.jsonl`), { recursive: true });
  try {
    classifierImpl = fakeClassifier(() => Promise.resolve({ route: "now", confidence: 0.92 }));
    const r = await sendMessage(orchestrator, "theta", "the transcript path is a directory");
    assert.equal(r.route, "now");
    assert.match(classifierCalls.at(-1)!.receiverTask!, /^session theta in \/work\/theta$/);
  } finally {
    classifierImpl = undefined;
    await closeServer(theta.server);
  }
});
