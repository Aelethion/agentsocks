import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { root, fakeClaude, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress } from "../src/envelope.ts";
import { codexIdentity, type Me } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";
import { brokerCall } from "../src/client.ts";
import { computeStats, type PeerStatus, type MessageRecord, type StatRow } from "../src/status.ts";
import type { TaskRow } from "../src/store.ts";

const broker = new Broker();
let alpha: FakeClaude;
const MIN = 60_000;
const rpc = <T>(op: string, args: Record<string, unknown>) => brokerCall<T>(op, args, { autoStart: false });
const codexTarget = (threadId: string, name: string, me?: Me) => ({ kind: "codex", addr: encodeAddress(me?.socketPath ?? `${process.env.AGENTSOCKS_RUNTIME_DIR}/t/${threadId}.sock`), name, threadId });
const partyOf = (me: Me) => ({ kind: me.kind, name: me.name, addr: me.socketPath ? encodeAddress(me.socketPath) : null, session: me.session ?? null, mode: null });
const aliasAddr = (threadId: string) => encodeAddress(`${process.env.AGENTSOCKS_RUNTIME_DIR}/t/${threadId}.sock`);
const sender: Me = { kind: "claude", name: "orchestrator", socketPath: `${root}/cc-socks/orch.sock`, session: "orch-session" };

before(async () => {
  await broker.start();
  alpha = await fakeClaude("alpha", process.pid, "idle");
});

after(async () => {
  await closeServer(alpha.server);
  await broker.stop();
});

function task(over: Partial<TaskRow>): TaskRow {
  const now = Date.now();
  return { id: `T-${randomUUID().slice(0, 6)}`, from_addr: encodeAddress(`${root}/cc-socks/lead.sock`), from_name: "lead", to_addr: "", to_name: "", to_kind: "codex", title: "t", body: "b", acceptance: null, risk: "low", external_ref: null, on_behalf_of: null, status: "open", result: null, evidence: null, from_session: null, to_session: null, request_id: null, created_at: now, updated_at: now, expires_at: now + 24 * 60 * MIN, ...over };
}

test("peer_status for a Codex session shows what is asked of it next to what it is doing", async () => {
  await broker.hook({ threadId: "thread-s1", event: "SessionStart", cwd: "/work/s1" });
  await broker.hook({ threadId: "thread-s1", event: "UserPromptSubmit", prompt: "migrate the billing tables" });
  await broker.hook({ threadId: "thread-s1", event: "PostToolUse", toolName: "apply_patch" });
  const me = await codexIdentity("thread-s1");
  broker.store.insertTask(task({ to_addr: aliasAddr("thread-s1"), to_name: me.name, status: "in_progress" }));
  await sendMessage(sender, "codex-s1", "please review the PR when done");
  await sendMessage(sender, "codex-s1", "FYI the lint job is green", undefined, { urgency: "fyi" });
  const s = await rpc<PeerStatus>("peer_status", { to: codexTarget("thread-s1", me.name, me) });
  assert.deepEqual(s.peer, { name: "codex-s1", kind: "codex", addr: encodeAddress(`${process.env.AGENTSOCKS_RUNTIME_DIR}/t/thread-s1.sock`) });
  assert.equal(s.desired.openTasks.length, 1);
  assert.deepEqual([s.desired.unreadMessages, s.desired.heldDigests], [1, 1]);
  assert.deepEqual([s.actual.state, s.actual.currentTask, s.actual.lastTool], ["busy", "migrate the billing tables", "apply_patch"]);
  assert.ok(s.actual.lastActivity! > Date.now() - 10_000);
  assert.deepEqual(s.drift, [], "a healthy busy session has no drift");
});

test("drift: idle with unread older than five minutes", async () => {
  await broker.hook({ threadId: "thread-s2", event: "SessionStart", cwd: "/work/s2" });
  const me = await codexIdentity("thread-s2");
  broker.store.enqueue({ id: "u1", msg_id: "u1", to_thread: "thread-s2", kind: "message", from_addr: null, from_name: "x", from_kind: "claude", from_session: null, from_mode: null, body: "hello", received_at: Date.now() - 4 * MIN });
  const target = codexTarget("thread-s2", me.name, me);
  assert.deepEqual((await rpc<PeerStatus>("peer_status", { to: target })).drift, [], "four minutes is fine");
  broker.store.db.prepare("UPDATE messages SET received_at = ? WHERE id = 'u1'").run(Date.now() - 6 * MIN);
  const s = await rpc<PeerStatus>("peer_status", { to: target });
  assert.deepEqual(s.drift.map((d) => d.code), ["idle-with-unread"]);
  assert.match(s.drift[0]!.detail, /1 unread, the oldest 6 min old/);
  broker.store.updateThread("thread-s2", { state: "busy" });
  assert.deepEqual((await rpc<PeerStatus>("peer_status", { to: target })).drift, [], "a busy session with unread messages is normal");
});

test("drift: an accepted or in-progress task with no update for two hours, and a busy session with no activity for fifteen minutes", async () => {
  await broker.hook({ threadId: "thread-s3", event: "SessionStart", cwd: "/work/s3" });
  const me = await codexIdentity("thread-s3");
  const addr = aliasAddr("thread-s3");
  const stale = task({ to_addr: addr, to_name: me.name, status: "in_progress", updated_at: Date.now() - 3 * 60 * MIN });
  const fresh = task({ to_addr: addr, to_name: me.name, status: "accepted", updated_at: Date.now() - 119 * MIN });
  const waiting = task({ to_addr: addr, to_name: me.name, status: "open", updated_at: Date.now() - 5 * 60 * MIN });
  for (const t of [stale, fresh, waiting]) broker.store.insertTask(t);
  broker.store.updateThread("thread-s3", { state: "busy", last_activity: Date.now() - 16 * MIN });
  const target = codexTarget("thread-s3", me.name, me);
  const s = await rpc<PeerStatus>("peer_status", { to: target });
  assert.deepEqual(s.drift.map((d) => d.code).sort(), ["busy-without-activity", "task-stale"]);
  assert.ok(s.drift.find((d) => d.code === "task-stale")!.detail.startsWith(stale.id));
  assert.equal(s.desired.openTasks.length, 3);
  broker.store.updateThread("thread-s3", { last_activity: Date.now() - 14 * MIN });
  assert.deepEqual((await rpc<PeerStatus>("peer_status", { to: target })).drift.map((d) => d.code), ["task-stale"]);
});

test("a task still open thirty minutes after it was created is flagged as not accepted yet, whatever was done to it since", async () => {
  await broker.hook({ threadId: "thread-s8", event: "SessionStart", cwd: "/work/s8" });
  const me = await codexIdentity("thread-s8");
  const target = codexTarget("thread-s8", me.name, me);
  const waiting = task({ to_addr: aliasAddr("thread-s8"), to_name: me.name, status: "open", created_at: Date.now() - 29 * MIN });
  broker.store.insertTask(waiting);
  assert.deepEqual((await rpc<PeerStatus>("peer_status", { to: target })).drift, [], "twenty-nine minutes is fine");
  broker.store.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(Date.now() - 31 * MIN, waiting.id);
  const flagged = await rpc<PeerStatus>("peer_status", { to: target });
  assert.deepEqual(flagged.drift.map((d) => d.code), ["task-unaccepted"]);
  assert.match(flagged.drift[0]!.detail, new RegExp(`^${waiting.id} is still open 31 min after it was created, not accepted yet$`));
  broker.store.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(Date.now(), waiting.id);
  assert.deepEqual((await rpc<PeerStatus>("peer_status", { to: target })).drift.map((d) => d.code), ["task-unaccepted"], "touching the row does not reset the clock");
  broker.store.db.prepare("UPDATE tasks SET status = 'accepted' WHERE id = ?").run(waiting.id);
  assert.deepEqual((await rpc<PeerStatus>("peer_status", { to: target })).drift, [], "an accepted task is judged by the two-hour rule instead");
});

test("peer_status for a Claude session reads the registry and the outbox: unread is sent-but-not-yet-seen, held digests are counted", async () => {
  alpha.setStatus("idle");
  const target = { kind: "claude", addr: encodeAddress(alpha.socketPath), name: "alpha", sessionId: alpha.sessionId };
  const sent = await sendMessage(sender, "alpha", "ping");
  const held = await sendMessage(sender, "alpha", "FYI later", undefined, { urgency: "fyi" });
  assert.equal(held.route, "digest");
  let s = await rpc<PeerStatus>("peer_status", { to: target });
  assert.deepEqual([s.actual.state, s.desired.unreadMessages, s.desired.heldDigests], ["idle", 1, 1]);
  assert.deepEqual(s.drift, []);
  broker.store.db.prepare("UPDATE outbox SET created_at = ?, sent_at = ? WHERE msg_id = ?").run(Date.now() - 8 * MIN, Date.now() - 8 * MIN, sent.msgId);
  s = await rpc<PeerStatus>("peer_status", { to: target });
  assert.deepEqual(s.drift.map((d) => d.code), ["idle-with-unread"]);
  broker.store.db.prepare("UPDATE outbox SET status = 'replied', shown_at = ?, replied_at = ? WHERE msg_id = ?").run(Date.now() - 2 * MIN, Date.now() - MIN, sent.msgId);
  s = await rpc<PeerStatus>("peer_status", { to: target });
  assert.deepEqual([s.desired.unreadMessages, s.drift.length], [0, 0]);
  assert.ok(s.actual.lastShown! > 0 && s.actual.lastReply! > 0);
  await assert.rejects(rpc("peer_status", { to: codexTarget("thread-unknown", "nobody") }), /no Codex session known/);
});

test("message_status gives the decision and the timeline without the message text, and finds a digest by the message that carried it", async () => {
  alpha.setStatus("busy");
  const r = await sendMessage(sender, "alpha", "SECRET body text for the status call", undefined, { urgency: "fyi" });
  alpha.setStatus("idle");
  await broker.runSweep();
  const s = await rpc<MessageRecord & { decision: { route: string; by: string; rule: string; reason: string } }>("message_status", { msgId: r.msgId, party: partyOf(sender) });
  assert.equal(s.msg_id, r.msgId);
  assert.equal(s.status, "sent");
  assert.deepEqual([s.decision.route, s.decision.by, s.decision.rule], ["digest", "rule", "fyi"]);
  assert.ok(s.decision.reason.endsWith("."));
  assert.ok(s.sent_at! >= s.created_at);
  assert.equal(s.bodyChars, "SECRET body text for the status call".length);
  assert.ok(!JSON.stringify(s).includes("SECRET"), "the text of the message is not echoed");
  assert.ok(s.carrier_id);
  assert.equal((await rpc<MessageRecord>("message_status", { msgId: s.carrier_id!, party: partyOf(sender) })).carrier_id, s.carrier_id, "the carrier id finds a row of the batch it delivered");
  await assert.rejects(rpc("message_status", { msgId: "no-such-id", party: partyOf(sender) }), /no message no-such-id/);
});

const row = (over: Partial<StatRow>): StatRow => ({ from_addr: "uds:/s", to_addr: "uds:/r", to_name: "r", to_kind: "claude", route: "pause", status: "sent", urgency: "normal", rule: null, created_at: 0, sent_at: 0, shown_at: null, replied_at: null, ...over });

test("stats: route counts, median time to shown and to reply", () => {
  const NOW = 10 * 60 * MIN;
  const [d] = computeStats(
    [
      row({ route: "now", created_at: 0, shown_at: 2_000, replied_at: 60_000 }),
      row({ route: "now", created_at: 100_000, shown_at: 106_000, replied_at: 220_000 }),
      row({ route: "pause", created_at: 200_000, shown_at: 210_000 }),
      row({ route: "digest", created_at: 300_000, shown_at: 900_000 }),
      row({ route: "merge", status: "merged", created_at: 400_000 }),
      row({ route: "now", status: "failed", created_at: 500_000 }),
    ],
    NOW,
  );
  assert.deepEqual(d!.routes, { now: 2, pause: 1, digest: 1, merge: 1 });
  assert.equal(d!.messages, 5, "failed sends are not counted as messages");
  assert.equal(d!.medianMsToShown, 8_000, "median of 2s, 6s, 10s, 600s");
  assert.equal(d!.medianMsToReply, 90_000, "median of 60s and 120s");
});

test("stats: interrupt precision is the share of messages that interrupted a busy receiver and were answered within 30 minutes, counting only those old enough to judge", () => {
  const NOW = 120 * MIN;
  const [d] = computeStats(
    [
      row({ route: "now", created_at: 0, replied_at: 5 * MIN }),
      row({ route: "now", created_at: 1000, replied_at: 40 * MIN }),
      row({ route: "now", created_at: 2000 }),
      row({ route: "now", created_at: 100 * MIN }),
      row({ route: "now", created_at: 110 * MIN, replied_at: 112 * MIN }),
      row({ route: "now", rule: "receiver-idle", created_at: 3000 }),
      row({ route: "now", rule: "awaited-reply", created_at: 4000, replied_at: 5000 }),
    ],
    NOW,
  );
  assert.deepEqual(d!.interruptPrecision, { interrupts: 5, matured: 4, repliedWithin30m: 2, precision: 0.5 }, "idle deliveries and awaited replies interrupted nobody");
  assert.equal(computeStats([row({ route: "pause" })], NOW)[0]!.interruptPrecision.precision, null);
});

test("stats: a follow-up that is itself fyi is not an escalation", () => {
  const [d] = computeStats([row({ route: "pause", created_at: 0 }), row({ route: "digest", urgency: "fyi", created_at: MIN, sent_at: null }), row({ route: "pause", created_at: 2 * MIN })], 100 * MIN);
  assert.equal(d!.escalations, 1, "only the second pause nags; the fyi between them does not");
});

test("stats: cost grows with the number of rows, not with its square", () => {
  const now = Date.now();
  const rows = Array.from({ length: 24_000 }, (_, i) =>
    row({ from_addr: `uds:/s${i % 7}`, route: (["now", "pause", "digest"] as const)[i % 3]!, created_at: now - (24_000 - i) * 30, sent_at: i % 2 ? now : null }),
  );
  const t0 = performance.now();
  const [d] = computeStats(rows, now);
  const took = performance.now() - t0;
  assert.equal(d!.messages, 24_000);
  assert.ok(took < 1000, `24,000 rows took ${Math.round(took)} ms`);
});

test("stats: a single message is not pluralised", async () => {
  const { formatStats } = await import("../src/render.ts");
  const text = formatStats({ days: 14, destinations: computeStats([row({ route: "now" })], 10 * MIN) });
  assert.match(text, /: 1 message, now 1/);
});

test("stats: an escalation is a follow-up from the same sender while an earlier one is still held or paused", () => {
  const NOW = 100 * MIN;
  const [d] = computeStats(
    [
      row({ route: "pause", created_at: 0, shown_at: 5 * MIN }),
      row({ route: "pause", created_at: MIN, shown_at: 6 * MIN }),
      row({ route: "digest", created_at: 10 * MIN, sent_at: null }),
      row({ route: "pause", created_at: 11 * MIN, shown_at: 30 * MIN }),
      row({ route: "now", created_at: 50 * MIN, from_addr: "uds:/someone-else" }),
      row({ route: "pause", created_at: 60 * MIN }),
    ],
    NOW,
  );
  assert.equal(d!.escalations, 3, "the second pause, the pause after the held digest, and the digest-then-pause pair; unrelated senders and settled messages do not count");
});

test("stats over the socket: grouped per destination, filterable by name", async () => {
  const all = await rpc<{ destinations: { to: { name: string }; messages: number }[] }>("stats", {});
  assert.ok(all.destinations.some((d) => d.to.name === "alpha" && d.messages >= 2));
  const only = await rpc<{ destinations: { to: { name: string } }[] }>("stats", { to: "@Alpha" });
  assert.deepEqual([...new Set(only.destinations.map((d) => d.to.name))], ["alpha"]);
});

test("a busy Claude session is never flagged for silence, since the registry's updatedAt is not hook activity", async () => {
  alpha.setStatus("busy");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  writeFileSync(join(root, "claude-sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: alpha.sessionId, cwd: "/work/alpha", name: "alpha", messagingSocketPath: alpha.socketPath, kind: "interactive", status: "busy", updatedAt: Date.now() - 60 * MIN }));
  const s = await rpc<PeerStatus>("peer_status", { to: { kind: "claude", addr: encodeAddress(alpha.socketPath), name: "alpha", sessionId: alpha.sessionId } });
  assert.equal(s.actual.state, "busy");
  assert.deepEqual(s.drift, []);
});

test("unread time counts from when a digest was released, not from when it arrived", async () => {
  await broker.hook({ threadId: "thread-s4", event: "SessionStart", cwd: "/work/s4" });
  const me = await codexIdentity("thread-s4");
  const target = codexTarget("thread-s4", me.name, me);
  broker.store.enqueue({ id: "d1", msg_id: "d1", to_thread: "thread-s4", kind: "message", from_addr: null, from_name: "x", from_kind: "claude", from_session: null, from_mode: null, body: "FYI", received_at: Date.now() - 20 * MIN, route: "digest", decision: null, held: true });
  broker.store.releaseHeld("thread-s4", Date.now() - MIN);
  assert.deepEqual((await rpc<PeerStatus>("peer_status", { to: target })).drift, [], "released a minute ago, so not yet late");
  broker.store.db.prepare("UPDATE messages SET released_at = ? WHERE id = 'd1'").run(Date.now() - 6 * MIN);
  assert.deepEqual((await rpc<PeerStatus>("peer_status", { to: target })).drift.map((d) => d.code), ["idle-with-unread"]);
});
