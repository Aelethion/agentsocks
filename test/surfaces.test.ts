import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, sleep, until, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { OldBrokerError, brokerCall } from "../src/client.ts";
import { encodeAddress, messageContent, parseEnvelope } from "../src/envelope.ts";
import { stopOlderBroker } from "../src/install.ts";
import { changeTask, createTask, peerStatus } from "../src/ops.ts";
import { codexIdentity, listPeers, type Me } from "../src/peers.ts";
import { deliveryNote } from "../src/routing.ts";
import { sendMessage } from "../src/send.ts";
import { threadSocketPath } from "../src/paths.ts";
import { senderLabel, noticeLine } from "../src/codexframe.ts";
import { VERSION } from "../src/version.ts";
import type { Classifier } from "../src/classifier.ts";
import { tempDir } from "./tmp.ts";

let classifier: Classifier | undefined;
const broker = new Broker({ wakeEnabled: false, classifier: () => classifier });
const claude = (c: FakeClaude): Me => ({ kind: "claude", name: c.name, socketPath: c.socketPath, session: c.sessionId });

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("what a sender is told, route by route", async () => {
  const busy = await fakeClaude("noteabusy", livePid(), "busy");
  const calm = await fakeClaude("noteacalm", livePid(), "idle");
  const me: Me = { kind: "cli", name: "cli-notes" };
  try {
    const idle = await sendMessage(me, "noteacalm", "to an idle one");
    assert.equal(idle.note, "Delivered. They see it at their next tool call, or right away if idle.");
    const now = await sendMessage(me, "noteabusy", "to a busy one");
    assert.equal(now.note, "Delivered. They see it at their next tool call, or right away if idle.");
    const fyi = await sendMessage(me, "noteabusy", "FYI one", undefined, { urgency: "fyi" });
    assert.equal(fyi.note, "Batched with other low-priority messages. They see it when they are next idle, within 15 minutes at most.");
    const again = await sendMessage(me, "noteabusy", "to a busy one");
    assert.equal(again.note, "Not sent again: you sent the same text to them in the last 10 minutes.");
    for (let i = 0; i < 2; i++) await sendMessage(me, "noteabusy", `fill the interrupt budget ${i}`);
    const over = await sendMessage(me, "noteabusy", "now over budget");
    assert.equal(over.route, "pause");
    assert.equal(over.note, "Delivered. They are busy and over their interruption budget, so they see it when their current turn ends. Send with urgency urgent if it cannot wait.");
    classifier = { name: "stub", remote: false, threshold: 0.6, timeoutMs: 500, async classify() { return { route: "pause", confidence: 0.9 }; } };
    const judged = await sendMessage(me, "noteacalm", "x", undefined, { urgency: "fyi" });
    assert.equal(judged.route, "digest");
    assert.doesNotMatch([now, idle, fyi, again, over].map((r) => r.note).join(" "), /classifier|step/i, "no classifier talk, and turns not steps");
  } finally {
    classifier = undefined;
    await closeServer(busy.server);
    await closeServer(calm.server);
  }
  assert.match(deliveryNote({ status: "sent", decision: { route: "pause", by: "classifier", reason: "r" }, to: { name: "x", kind: "claude" } }, "normal"), /^Delivered\. They are busy and the classifier judged it can wait until their current turn ends\. Send with urgency urgent if it cannot wait\.$/);
  assert.doesNotMatch(deliveryNote({ status: "sent", decision: { route: "pause", by: "budget", reason: "r" }, to: { name: "x", kind: "claude" } }, "urgent"), /Send with urgency urgent/, "an urgent message is not told to be urgent");
});

test("a batched note tells a Codex receiver's sender what is true for Codex: its next read or turn, not an idle moment", async () => {
  const me: Me = { kind: "cli", name: "cli-codex-note" };
  await broker.hook({ threadId: "thread-notebox", event: "SessionStart", cwd: "/work/notebox" });
  await broker.hook({ threadId: "thread-notebox", event: "Stop" });
  const fyi = await sendMessage(me, "codex-notebox", "FYI the cache was rebuilt", undefined, { urgency: "fyi" });
  assert.equal(fyi.route, "digest");
  assert.equal(fyi.note, "Batched with other low-priority messages. They see it the next time they read their inbox or start a turn.");
  assert.doesNotMatch(fyi.note, /idle|15 minutes/);
});

test("the Codex notice says to read before the next step, and names senders by count", () => {
  assert.equal(noticeLine({ messages: 1, receipts: 0 }, "working", "a Claude Code session"), "📨 agentsocks: new message from a Claude Code session. Read it with read_inbox before your next step.");
  assert.equal(senderLabel(["claude"]), "a Claude Code session");
  assert.equal(senderLabel(["codex"]), "a Codex session");
  assert.equal(senderLabel([null]), "another agent session");
  assert.equal(senderLabel(["claude", "codex"]), "2 sessions");
  assert.equal(senderLabel(["claude", "claude", "claude"]), "3 sessions");
});

test("two messages from one session are announced as two messages from a single session", async () => {
  const lead = await fakeClaude("grammar", livePid(), "idle");
  await broker.hook({ threadId: "thread-grammar", event: "SessionStart", cwd: "/work/grammar" });
  await broker.hook({ threadId: "thread-grammar", event: "UserPromptSubmit", prompt: "busy" });
  try {
    await sendMessage(claude(lead), "codex-grammar", "first");
    await sendMessage(claude(lead), "codex-grammar", "second");
    const mid = await broker.hook({ threadId: "thread-grammar", event: "PostToolUse" });
    assert.equal(mid.context, "📨 agentsocks: 2 new messages from a Claude Code session. Read them with read_inbox before your next step.");
  } finally {
    await closeServer(lead.server);
  }
});

test("a session can ask for its own status", async () => {
  await broker.hook({ threadId: "thread-self", event: "SessionStart", cwd: "/work/self" });
  await broker.hook({ threadId: "thread-self", event: "UserPromptSubmit", prompt: "look at myself" });
  const me = await codexIdentity("thread-self");
  const status = await peerStatus(me, me.name);
  assert.deepEqual([status.peer.name, status.actual.state, status.actual.currentTask], [me.name, "busy", "look at myself"]);
  await assert.rejects(sendMessage(me, me.name, "talking to myself"), /cannot message yourself/, "sending to yourself is still refused");
});

test("when a task finishes, its still-held progress notices are superseded, and update_task reports what became of its notice", async () => {
  const lead = await fakeClaude("noticelead", livePid(), "busy");
  const worker = await codexIdentity("notice-worker", "/work/notice");
  try {
    const { task } = await createTask(claude(lead), { to: "codex-notice", title: "Tidy the module", details: "d" });
    const progress = await changeTask(worker, task.id, "accepted");
    assert.deepEqual([progress.notice.outcome, progress.notice.to], ["batched", "creator"], "a progress notice to a busy creator is batched");
    await changeTask(worker, task.id, "in_progress", "halfway");
    const held = () => broker.store.db.prepare("SELECT status FROM outbox WHERE task_id = ? AND urgency = 'fyi'").all(task.id).map((r) => (r as { status: string }).status);
    assert.deepEqual(held(), ["held", "held"]);
    const done = await changeTask(worker, task.id, "done", "all tidy", "npm test: ok");
    assert.equal(done.notice.outcome, "sent", "the done notice reaches a busy creator at its next tool call");
    assert.deepEqual(held(), ["merged", "merged"], "the progress notices that were still waiting no longer matter");
    const bodies = await until(() => (lead.frames.length >= 1 ? lead.frames.map((f) => parseEnvelope(messageContent(f))!.body) : undefined));
    assert.ok(bodies.some((b) => b.includes(`${task.id}] Tidy the module: done`)));
    assert.ok(!bodies.some((b) => b.includes("in progress")), "the superseded notices were never flushed");
    lead.setStatus("idle");
    await broker.runSweep();
    await sleep(100);
    assert.ok(!lead.frames.some((f) => parseEnvelope(messageContent(f))!.body.includes("agentsocks digest")));

    const gone = await fakeClaude("noticegone", livePid(), "idle");
    const t2 = await createTask(claude(gone), { to: "codex-notice", title: "Second", details: "d" });
    await closeServer(gone.server);
    const failed = await changeTask(worker, t2.task.id, "done", "ok");
    assert.equal(failed.notice.outcome, "not-sent");
    assert.match(failed.notice.detail!, /no inbox socket|not running/);
    assert.equal(failed.notified, false);
  } finally {
    await closeServer(lead.server);
  }
});

test("an old broker is reported plainly, and install stops it", async () => {
  const dir = tempDir("as-old-broker-");
  const script = join(dir, "cli.js");
  writeFileSync(
    script,
    `const net = require("net"), fs = require("fs"), path = require("path");
const run = process.env.AGENTSOCKS_RUNTIME_DIR;
fs.mkdirSync(path.join(run, "broker.lock"), { recursive: true });
fs.writeFileSync(path.join(run, "broker.lock", "pid"), String(process.pid));
const server = net.createServer((s) => s.on("data", (d) => {
  const req = JSON.parse(String(d).split("\\n")[0]);
  s.end(JSON.stringify(req.op === "ping" ? { id: 1, ok: true, result: { pid: process.pid, version: "0.1.0", threads: 0 } } : { id: 1, ok: false, error: "unknown op " + req.op }) + "\\n");
}));
server.listen(path.join(run, "broker.sock"), () => console.log("ready"));
process.on("SIGTERM", () => { try { fs.unlinkSync(path.join(run, "broker.lock", "pid")); } catch {} try { fs.rmdirSync(path.join(run, "broker.lock")); } catch {} server.close(() => process.exit(0)); });
`,
  );
  const run = join(dir, "run");
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const saved = process.env.AGENTSOCKS_RUNTIME_DIR;
  process.env.AGENTSOCKS_RUNTIME_DIR = run;
  const old = spawn(process.execPath, [script, "daemon"], { env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve) => old.on("exit", resolve));
  try {
    await new Promise((resolve) => old.stdout!.once("data", resolve));
    const failure = await brokerCall("route_send", { body: "x" }, { autoStart: false }).catch((e: Error) => e);
    assert.ok(failure instanceof OldBrokerError);
    assert.equal(failure.message, `The running agentsocks broker is an older version. Run \`agentsocks install\` (or stop pid ${old.pid}) and retry.`);

    const dry: string[] = [];
    await stopOlderBroker(dry, true);
    assert.match(dry.join("\n"), new RegExp(`dry run.*pid ${old.pid}`));
    assert.equal(old.exitCode, null, "a dry run stops nothing");

    const log: string[] = [];
    await stopOlderBroker(log, false);
    await exited;
    assert.match(log.join("\n"), new RegExp(`stopped the v0.1.0 daemon \\(pid ${old.pid}\\); the next command starts v${VERSION.replace(".", "\\.")}`));
    assert.ok(!existsSync(join(run, "broker.lock")), "the lock is gone, so the next call can start the new broker");
  } finally {
    old.kill("SIGKILL");
    process.env.AGENTSOCKS_RUNTIME_DIR = saved;
  }
});

test("install leaves a process alone that does not look like an agentsocks daemon", async () => {
  const dir = tempDir("as-impostor-");
  const script = join(dir, "other.js");
  writeFileSync(
    script,
    `const net = require("net"), path = require("path");
net.createServer((s) => s.on("data", () => s.end(JSON.stringify({ id: 1, ok: true, result: { pid: process.pid, version: "0.1.0", threads: 0 } }) + "\\n"))).listen(path.join(process.env.AGENTSOCKS_RUNTIME_DIR, "broker.sock"), () => console.log("ready"));`,
  );
  const run = join(dir, "run");
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const saved = process.env.AGENTSOCKS_RUNTIME_DIR;
  process.env.AGENTSOCKS_RUNTIME_DIR = run;
  const impostor = spawn(process.execPath, [script], { env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise((resolve) => impostor.stdout!.once("data", resolve));
    const log: string[] = [];
    await stopOlderBroker(log, false);
    assert.match(log.join("\n"), /does not look like an agentsocks daemon, so it was left alone/);
    assert.equal(impostor.exitCode, null);
  } finally {
    impostor.kill("SIGKILL");
    process.env.AGENTSOCKS_RUNTIME_DIR = saved;
  }
});

test("a Codex peer's ref is the hash of its stable thread path, so refs survive the move to the cc-socks directory", async () => {
  await broker.hook({ threadId: "thread-ref", event: "SessionStart", cwd: "/work/ref" });
  const peer = (await listPeers()).find((p) => p.session === "thread-ref")!;
  const v01 = createHash("sha256").update(threadSocketPath("thread-ref")).digest("hex").slice(0, peer.ref.length);
  assert.equal(peer.ref, v01);
  assert.notEqual(peer.socketPath, threadSocketPath("thread-ref"), "while the advertised address is the namespaced one");
});
