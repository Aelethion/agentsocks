import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { root, wakeLog, sleep, until, fakeClaude, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer, postLines } from "../src/ccsocks.ts";
import { encodeAddress, messageContent, parseEnvelope } from "../src/envelope.ts";
import { canonicalPath } from "../src/paths.ts";
import { codexIdentity, type Me } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";
import { TranscriptWatcher, peerOriginMsgIds } from "../src/transcript.ts";
import type { TtyActivity } from "../src/typing.ts";
import type { OutboxRow } from "../src/store.ts";

let ttys: TtyActivity[] = [];
const broker = new Broker({ ttyScan: () => ttys });
let alpha: FakeClaude;
let gone: FakeClaude;
const sender = (name: string): Me => ({ kind: "claude", name, socketPath: join(root, "cc-socks", `${name}.sock`), session: `${name}-session` });
const outbox = (msgId: string): OutboxRow => broker.store.getOutbox(msgId)!;
const wakes = () => (existsSync(wakeLog) ? readFileSync(wakeLog, "utf8") : "");
const MIN = 60_000;

before(async () => {
  await broker.start();
  alpha = await fakeClaude("alpha", process.pid, "busy");
  gone = await fakeClaude("gone", process.ppid, "busy");
});

after(async () => {
  await closeServer(alpha.server);
  await broker.stop();
});

test("held Claude digests flush as one combined message per sender when the receiver turns idle", async () => {
  alpha.setStatus("busy");
  const ann = sender("ann");
  const bob = sender("bob");
  const sent = [];
  for (const body of ["FYI one", "FYI two", "FYI three"]) sent.push(await sendMessage(ann, "alpha", body, undefined, { urgency: "fyi" }));
  const other = await sendMessage(bob, "alpha", "FYI from bob", undefined, { urgency: "fyi" });
  assert.ok(sent.every((s) => s.route === "digest"));
  await broker.runSweep();
  await sleep(100);
  assert.equal(alpha.frames.length, 0, "nothing is flushed while the receiver is busy and the digest is young");

  alpha.setStatus("idle");
  await broker.runSweep();
  await until(() => alpha.frames.length === 2);
  const frames = alpha.frames.map((f) => ({ f, env: parseEnvelope(messageContent(f))! }));
  const fromAnn = frames.find((x) => x.env.fromName === "ann")!;
  const fromBob = frames.find((x) => x.env.fromName === "bob")!;
  assert.equal(fromAnn.f.priority, "later");
  assert.equal(fromAnn.env.from, encodeAddress(canonicalPath(ann.socketPath!)), "the digest is sent as that sender");
  const lines = fromAnn.env.body.split("\n");
  assert.match(lines[0]!, /^\[agentsocks digest\] 3 messages from ann/);
  assert.deepEqual(lines.filter((l) => /^\d\. /.test(l)).map((l) => l.replace(/^\d\. \([^)]*\) /, "")), ["FYI one", "FYI two", "FYI three"]);
  assert.ok(!fromAnn.env.body.includes("FYI from bob"), "digests never mix senders");
  assert.match(fromBob.env.body, /1 message from bob/);

  const rows = sent.map((s) => outbox(s.msgId));
  assert.ok(rows.every((r) => r.status === "sent" && r.sent_at !== null));
  assert.equal(new Set(rows.map((r) => r.carrier_id)).size, 1, "one carrier message for the whole batch");
  assert.equal(rows[0]!.carrier_id, (fromAnn.f as { msg_id: string }).msg_id);
  assert.notEqual(outbox(other.msgId).carrier_id, rows[0]!.carrier_id);
  await broker.runSweep();
  await sleep(100);
  assert.equal(alpha.frames.length, 2, "a flushed digest is not flushed again");
});

test("held digests from senders with no inbox address are grouped by name, so one digest never mixes two senders", async () => {
  alpha.setStatus("busy");
  const start = alpha.frames.length;
  const shell = (name: string): Me => ({ kind: "cli", name });
  await sendMessage(shell("cli-projA"), "alpha", "note from projA one", undefined, { urgency: "fyi" });
  await sendMessage(shell("cli-projB"), "alpha", "note from projB", undefined, { urgency: "fyi" });
  await sendMessage(shell("cli-projA"), "alpha", "note from projA two", undefined, { urgency: "fyi" });
  alpha.setStatus("idle");
  await broker.runSweep();
  await until(() => alpha.frames.length === start + 2);
  const bodies = alpha.frames.slice(start).map((f) => parseEnvelope(messageContent(f))!.body);
  const a = bodies.find((b) => b.includes("projA"))!;
  const b = bodies.find((b) => b.includes("projB"))!;
  assert.match(a, /^\[agentsocks digest\] 2 messages from cli-projA/);
  assert.ok(a.includes("note from projA one") && a.includes("note from projA two") && !a.includes("projB"));
  assert.match(b, /^\[agentsocks digest\] 1 message from cli-projB/);
  assert.ok(!b.includes("projA"));
  alpha.setStatus("busy");
});

test("an urgent repeat of a digest that was flushed to Claude but not yet shown is delivered, not merged away", async () => {
  alpha.setStatus("busy");
  const start = alpha.frames.length;
  const fay = sender("fay");
  const first = await sendMessage(fay, "alpha", "weekly report posted", undefined, { urgency: "fyi" });
  assert.equal(first.route, "digest");
  alpha.setStatus("idle");
  await broker.runSweep();
  await until(() => alpha.frames.length === start + 1);
  assert.equal(outbox(first.msgId).status, "sent");
  alpha.setStatus("busy");

  const again = await sendMessage(fay, "alpha", "weekly report posted", undefined, { urgency: "fyi" });
  assert.deepEqual([again.route, again.delivered], ["merge", false], "a repeat of equal weight is still merged");

  const urgent = await sendMessage(fay, "alpha", "weekly report posted", undefined, { urgency: "urgent" });
  assert.deepEqual([urgent.route, urgent.delivered], ["now", true]);
  assert.match(urgent.note, /It repeats the same text that was still waiting\./);
  await until(() => alpha.frames.length === start + 2);
  assert.equal(alpha.frames[start + 1]!.priority, "next");
  assert.equal(outbox(first.msgId).status, "sent", "the digest that was really delivered keeps its history");
});

test("an urgent repeat of a Codex digest that was released but not yet read replaces it instead of vanishing", async () => {
  await broker.hook({ threadId: "thread-f4", event: "SessionStart", cwd: "/work/f4" });
  await broker.hook({ threadId: "thread-f4", event: "UserPromptSubmit", prompt: "long task" });
  const fyi = await sendMessage(sender("gus"), "codex-f4", "deploy 41 finished", undefined, { urgency: "fyi" });
  assert.equal(fyi.route, "digest");
  await broker.hook({ threadId: "thread-f4", event: "Stop" });
  assert.equal(broker.store.queuedCount("thread-f4"), 1, "released to the idle thread, unread");
  const urgent = await sendMessage(sender("gus"), "codex-f4", "deploy 41 finished", undefined, { urgency: "urgent" });
  assert.deepEqual([urgent.route, urgent.delivered], ["now", true]);
  assert.equal(broker.store.queuedCount("thread-f4"), 1, "one copy, not two");
  const read = broker.take("thread-f4");
  assert.equal(read.count, 1);
  assert.ok(read.text.includes("deploy 41 finished"));
  assert.equal(outbox(fyi.msgId).status, "merged");
});

test("a digest older than 15 minutes is delivered even though the receiver is still busy", async () => {
  alpha.setStatus("busy");
  const before = alpha.frames.length;
  const r = await sendMessage(sender("cy"), "alpha", "FYI waiting a while", undefined, { urgency: "fyi" });
  await broker.runSweep(Date.now() + 14 * MIN);
  await sleep(100);
  assert.equal(alpha.frames.length, before);
  await broker.runSweep(Date.now() + 16 * MIN);
  await until(() => alpha.frames.length === before + 1);
  assert.equal(outbox(r.msgId).status, "sent");
  assert.equal(alpha.frames.at(-1)!.priority, "later");
});

test("a digest whose receiver has gone away is retried with backoff and marked failed only after an hour", async () => {
  const r = await sendMessage(sender("dee"), "gone", "FYI to a session that is about to exit", undefined, { urgency: "fyi" });
  await closeServer(gone.server);
  const t0 = Date.now();
  await broker.runSweep(t0 + 16 * MIN);
  let row = outbox(r.msgId);
  assert.equal(row.status, "held", "a failed post leaves the digest held");
  assert.match(row.error!, /^will retry: .*(no inbox socket|not running|Could not|ENOENT)/i);
  assert.equal(row.body, "FYI to a session that is about to exit", "and the text is kept for the retry");
  const firstError = row.error;
  await broker.runSweep(t0 + 16 * MIN + 10_000);
  assert.equal(outbox(r.msgId).error, firstError, "no new attempt inside the 30 second backoff");
  await broker.runSweep(t0 + 17 * MIN);
  assert.equal(outbox(r.msgId).status, "held", "still held while the hour has not passed");
  await broker.runSweep(t0 + 80 * MIN);
  row = outbox(r.msgId);
  assert.equal(row.status, "failed");
  assert.match(row.error!, /^gave up after an hour: /);
  assert.equal(row.body, "", "a failed row no longer keeps the text");
});

test("a flushed digest never claims a stronger permission class than every message in it had", async () => {
  alpha.setStatus("busy");
  const mixed = (name: string, mode?: "bypass" | "prompting"): Me => ({ ...sender(name), ...(mode && { mode }) });
  const flushed = async (name: string, modes: (("bypass" | "prompting") | undefined)[]) => {
    for (const [i, mode] of modes.entries()) await sendMessage(mixed(name, mode), "alpha", `FYI ${name} ${i}`, undefined, { urgency: "fyi" });
    const before = alpha.frames.length;
    alpha.setStatus("idle");
    await broker.runSweep();
    await until(() => alpha.frames.length === before + 1);
    alpha.setStatus("busy");
    return parseEnvelope(messageContent(alpha.frames.at(-1)!))!.fromMode;
  };
  assert.equal(await flushed("modeall", ["bypass", "bypass"]), "bypass");
  assert.equal(await flushed("modemix", ["prompting", "bypass"]), "prompting");
  assert.equal(await flushed("modeunknown", [undefined, "bypass"]), undefined, "an unknown class is omitted, never upgraded");
});

test("a digest is never truncated: a long message goes whole, and a batch over the size limit is split across several messages", async () => {
  alpha.setStatus("busy");
  const big = (n: number) => `message ${n} ${"x".repeat(30_000)} END${n}`;
  for (let i = 0; i < 4; i++) await sendMessage(sender("bulk"), "alpha", big(i), undefined, { urgency: "fyi" });
  const before = alpha.frames.length;
  alpha.setStatus("idle");
  await broker.runSweep();
  await until(() => alpha.frames.length >= before + 2);
  const bodies = alpha.frames.slice(before).map((f) => parseEnvelope(messageContent(f))!.body);
  assert.ok(bodies.length >= 2, "four 30 kB messages do not fit in one 64 KiB digest");
  for (const body of bodies) assert.ok(Buffer.byteLength(body) <= 64 * 1024, "each digest stays under the size limit");
  const text = bodies.join("\n");
  for (let i = 0; i < 4; i++) assert.ok(text.includes(`END${i}`) && !text.includes("[truncated]"), `message ${i} arrived whole`);
  alpha.setStatus("busy");
});

test("a digest says it was batched while the receiver was busy only when it was", async () => {
  alpha.setStatus("busy");
  await sendMessage(sender("wording"), "alpha", "FYI one", undefined, { urgency: "fyi" });
  const before = alpha.frames.length;
  await broker.runSweep(Date.now() + 16 * MIN);
  await until(() => alpha.frames.length === before + 1);
  assert.match(parseEnvelope(messageContent(alpha.frames.at(-1)!))!.body, /^\[agentsocks digest\] 1 message from wording, batched while you were busy\./);
  await sendMessage(sender("wording2"), "alpha", "FYI two", undefined, { urgency: "fyi" });
  alpha.setStatus("idle");
  await broker.runSweep();
  await until(() => alpha.frames.length === before + 2);
  const idleBody = parseEnvelope(messageContent(alpha.frames.at(-1)!))!.body;
  assert.doesNotMatch(idleBody, /while you were busy/);
  assert.match(idleBody, /^\[agentsocks digest\] 1 message from wording2, batched for your next idle moment\./);
  alpha.setStatus("busy");
});

test("when a Codex thread ends, its held digests become ordinary unread messages that a resumed thread sees, without a wake", async () => {
  await broker.hook({ threadId: "thread-end", event: "SessionStart", cwd: "/work/end" });
  await broker.hook({ threadId: "thread-end", event: "UserPromptSubmit", prompt: "task" });
  const r = await sendMessage(sender("fin"), "codex-end", "FYI left behind", undefined, { urgency: "fyi" });
  assert.equal(outbox(r.msgId).status, "held");
  const mark = wakes().length;
  await broker.hook({ threadId: "thread-end", event: "SessionEnd" });
  assert.equal(broker.store.queuedCount("thread-end"), 1, "unread now");
  assert.equal(outbox(r.msgId).status, "sent");
  const resumed = await broker.hook({ threadId: "thread-end", event: "SessionStart", cwd: "/work/end" });
  assert.match(resumed.context!, /new message/);
  await sleep(1800);
  assert.equal(wakes().length, mark, "no wake for an ended thread");
  assert.ok(broker.take("thread-end").text.includes("FYI left behind"));
});

test("Codex digests are released when the thread is idle, or after 15 minutes while it is busy; a released digest never blocks Stop", async () => {
  await broker.hook({ threadId: "thread-d1", event: "SessionStart", cwd: "/work/d1" });
  await broker.hook({ threadId: "thread-d1", event: "UserPromptSubmit", prompt: "long task" });
  const r = await sendMessage(sender("eve"), "codex-d1", "FYI long task update", undefined, { urgency: "fyi" });
  assert.equal(outbox(r.msgId).status, "held");
  await broker.runSweep(Date.now() + 5 * MIN);
  assert.equal(broker.store.queuedCount("thread-d1"), 0, "still held while busy and young");
  await broker.runSweep(Date.now() + 16 * MIN);
  assert.equal(broker.store.queuedCount("thread-d1"), 1, "released by age");
  assert.equal(outbox(r.msgId).status, "sent");
  const mid = await broker.hook({ threadId: "thread-d1", event: "PostToolUse" });
  assert.ok(mid.context?.includes("new message"), "a released digest is announced");
  const stop = await broker.hook({ threadId: "thread-d1", event: "Stop" });
  assert.equal(stop.block, undefined, "a digest never blocks Stop");
  broker.take("thread-d1");

  await broker.hook({ threadId: "thread-d2", event: "SessionStart", cwd: "/work/d2" });
  await broker.hook({ threadId: "thread-d2", event: "UserPromptSubmit", prompt: "task" });
  const q = await sendMessage(sender("eve"), "codex-d2", "FYI at idle", undefined, { urgency: "fyi" });
  assert.equal(broker.store.queuedCount("thread-d2"), 0);
  broker.store.updateThread("thread-d2", { state: "idle" });
  await broker.runSweep();
  assert.equal(broker.store.queuedCount("thread-d2"), 1, "the sweep releases a digest once the thread is idle");
  assert.equal(outbox(q.msgId).status, "sent");
});

test("wakes wait while someone is typing in a Codex terminal, re-check on the sweep, and give up holding after ten minutes of quiet gaps", async () => {
  await broker.hook({ threadId: "thread-w1", event: "SessionStart", cwd: "/work/w1" });
  const before = wakes();
  ttys = [{ pid: 1, tty: "/dev/pts/1", inputAgeMs: 2_000 }];
  await sendMessage(sender("fay"), "codex-w1", "wake me when nobody types");
  await until(() => broker.store.getThread("thread-w1")!.wake_hold_since !== null);
  await sleep(1800);
  assert.equal(wakes(), before, "no wake while a terminal had input 2 s ago");

  ttys = [];
  await broker.runSweep();
  await until(() => wakes().length > before.length && wakes().includes("thread-w1"));
  assert.equal(broker.store.getThread("thread-w1")!.wake_hold_since, null, "the hold is cleared once the wake is sent");

  await broker.hook({ threadId: "thread-w2", event: "SessionStart", cwd: "/work/w2" });
  const mark = wakes().length;
  broker.store.updateThread("thread-w2", { wake_hold_since: Date.now() - 11 * MIN });
  ttys = [{ pid: 1, tty: "/dev/pts/1", inputAgeMs: 5_000 }];
  await sendMessage(sender("fay"), "codex-w2", "held for eleven minutes already");
  await sleep(1800);
  assert.ok(!wakes().slice(mark).includes("thread-w2"), "still no wake: the terminal is not in an 18 second quiet gap");
  ttys = [{ pid: 1, tty: "/dev/pts/1", inputAgeMs: 20_000 }];
  await broker.runSweep();
  await until(() => wakes().slice(mark).includes("thread-w2"));
  ttys = [];
});

test("a Claude message is marked shown only when its msg_id appears in the receiver's transcript as a peer origin", async () => {
  alpha.setStatus("idle");
  const dir = join(process.env.AGENTSOCKS_CLAUDE_PROJECTS_DIR!, "-work-alpha");
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, `${alpha.sessionId}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "SECRET-TRANSCRIPT-TEXT hello" } })}\n`);
  const r = await sendMessage(sender("gus"), "alpha", "did you get this one");
  const later = (s: number) => Date.now() + 17 * MIN + s;
  await broker.runSweep(later(0));
  assert.equal(outbox(r.msgId).status, "sent");

  appendFileSync(transcript, `${JSON.stringify({ type: "user", origin: { kind: "user", msg_id: r.msgId }, message: { content: "typed by the user" } })}\n`);
  appendFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { content: `talking about ${r.msgId} in plain text` } })}\n`);
  await broker.runSweep(later(1));
  assert.equal(outbox(r.msgId).status, "sent", "an id outside a peer origin proves nothing");

  const t0 = Date.now();
  appendFileSync(transcript, `${JSON.stringify({ type: "user", origin: { kind: "peer", from: "uds:/x", msg_id: r.msgId }, message: { content: "<cross-session-message>…" } })}\n`);
  await broker.runSweep(later(2));
  const row = outbox(r.msgId);
  assert.equal(row.status, "shown");
  assert.ok(row.shown_at! >= t0);
  const logs = [join(process.env.AGENTSOCKS_STATE_DIR!, "audit.log"), join(process.env.AGENTSOCKS_STATE_DIR!, "daemon.log")].filter(existsSync).map((p) => readFileSync(p, "utf8")).join("\n");
  assert.ok(!logs.includes("SECRET-TRANSCRIPT-TEXT") && !logs.includes("typed by the user"), "transcript content is never logged");
  assert.equal(JSON.stringify(broker.store.db.prepare("SELECT * FROM outbox").all()).includes("SECRET-TRANSCRIPT-TEXT"), false, "or stored");
});

test("the transcript watcher reads only new bytes, copes with a partial last line and with truncation", async () => {
  const dir = join(process.env.AGENTSOCKS_CLAUDE_PROJECTS_DIR!, "-work-watch");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "watch-session.jsonl");
  const peer = (id: string) => JSON.stringify({ origin: { kind: "peer", msg_id: id } });
  writeFileSync(file, `${peer("m-old")}\n`);
  const w = new TranscriptWatcher();
  assert.deepEqual(await w.scan("watch-session", new Set(["m-old", "m-new"])), ["m-old"]);
  writeFileSync(file, `${"x".repeat(peer("m-old").length)}\n${peer("m-new").slice(0, 10)}`);
  assert.deepEqual(await w.scan("watch-session", new Set(["m-new"])), [], "a half-written line is left for later");
  appendFileSync(file, `${peer("m-new").slice(10)}\n`);
  assert.deepEqual(await w.scan("watch-session", new Set(["m-new"])), ["m-new"]);
  writeFileSync(file, `${peer("m-after-truncate")}\n`);
  assert.deepEqual(await w.scan("watch-session", new Set(["m-after-truncate"])), ["m-after-truncate"]);
  assert.deepEqual(await w.scan("no-such-session", new Set(["m-new"])), []);
  assert.deepEqual(peerOriginMsgIds('{"origin": {"kind": "peer", "msg_id": "z"}}', new Set(["z"])), ["z"], "whitespace in the JSON does not matter");
  const nested = JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }], meta: { origin: { kind: "peer", from: { name: "codex-x", socket: "uds:/y" }, msg_id: "deep" } } } });
  assert.deepEqual(peerOriginMsgIds(nested, new Set(["deep", "other"])), ["deep"], "an origin nested anywhere in the line counts, even with objects inside it");
  assert.deepEqual(peerOriginMsgIds(nested.replace('"peer"', '"user"'), new Set(["deep"])), []);
  assert.deepEqual(peerOriginMsgIds(JSON.stringify({ text: "origin kind peer msg_id deep" }), new Set(["deep"])), [], "the id merely appearing in text is not enough");
  assert.deepEqual(peerOriginMsgIds('{"cut off "origin":{"kind":"peer","msg_id":"z"}', new Set(["z"])), ["z"], "a line that is not valid JSON falls back to a flat origin match");
});

test("receipts from Claude update the outbox row of the sender, not anyone else's", async () => {
  alpha.setStatus("idle");
  const codex = await codexIdentity("thread-r1", "/work/r1");
  await broker.hook({ threadId: "thread-r1", event: "SessionStart", cwd: "/work/r1" });
  const other = await codexIdentity("thread-r2", "/work/r2");
  const held = await sendMessage(codex, "alpha", "needs approval");
  const refused = await sendMessage(codex, "alpha", "please do something else");
  const dropped = await sendMessage(codex, "alpha", "and another thing");
  const foreign = await sendMessage(other, "alpha", "mine, not r1's");
  const sock = join(process.env.AGENTSOCKS_RUNTIME_DIR!, "t", "thread-r1.sock");
  const receipt = (status: string, id: string, reason: string) => JSON.stringify({ type: "control", action: "peer_message_status", status, orig_msg_id: id, reason });
  await postLines(sock, [receipt("held", held.msgId, "awaiting approval"), receipt("denied", refused.msgId, "user said no"), receipt("expired", dropped.msgId, "no answer"), receipt("held", foreign.msgId, "not yours")]);
  await until(() => broker.store.queuedCount("thread-r1") === 4);
  assert.equal(outbox(held.msgId).status, "held");
  assert.match(outbox(held.msgId).error!, /held: awaiting approval/);
  assert.equal(outbox(refused.msgId).status, "refused");
  assert.equal(outbox(dropped.msgId).status, "failed");
  assert.equal(outbox(foreign.msgId).status, "sent", "a receipt that reaches another thread cannot change this row");
  assert.ok(broker.take("thread-r1").text.includes("Delivery notices"), "the v0.1 notices are still queued");

  const dir = join(process.env.AGENTSOCKS_CLAUDE_PROJECTS_DIR!, "-work-alpha");
  appendFileSync(join(dir, `${alpha.sessionId}.jsonl`), `${JSON.stringify({ origin: { kind: "peer", msg_id: held.msgId } })}\n`);
  await broker.runSweep(Date.now() + 17 * MIN);
  assert.equal(outbox(held.msgId).status, "shown", "a message the receiver's gate held shows up once approved");
});

test("an id that became wanted after the watcher read past its line is still found", async () => {
  const dir = join(process.env.AGENTSOCKS_CLAUDE_PROJECTS_DIR!, "-work-late");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "late-session.jsonl");
  const peer = (id: string) => JSON.stringify({ origin: { kind: "peer", msg_id: id } });
  writeFileSync(file, `${peer("m-first")}\n`);
  const w = new TranscriptWatcher();
  assert.deepEqual(await w.scan("late-session", new Set(["m-first"])), ["m-first"]);
  appendFileSync(file, `${peer("m-late")}\n${peer("m-other")}\n`);
  assert.deepEqual(await w.scan("late-session", new Set(["m-first", "m-other"])), ["m-other"], "the forward scan reads past m-late's line while it is not wanted");
  assert.deepEqual(await w.scan("late-session", new Set(["m-late"])), ["m-late"], "and a later scan that does want it looks back for it");
  assert.deepEqual(await w.scan("late-session", new Set(["m-late"])), [], "once found and searched, nothing more is reported");
});
