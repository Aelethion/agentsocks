import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./support.ts";
import { fakeClaude, livePid, root, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress } from "../src/envelope.ts";
import { gatewayState } from "../src/gateway/state.ts";
import { visiblePeers } from "../src/gateway/gtools.ts";
import type { Caller } from "../src/gateway/routes.ts";
import { threadSocketPath } from "../src/paths.ts";
import { codexIdentity, listPeers } from "../src/peers.ts";
import { formatPeerStatus } from "../src/render.ts";
import { deliveryNote, type Party, type Target } from "../src/routing.ts";
import { sendMessage } from "../src/send.ts";
import { peerStatus, type PeerStatus } from "../src/status.ts";

const broker = new Broker({ classifier: () => undefined, wakeEnabled: false });
const addrOf = (id: string): string => encodeAddress(threadSocketPath(id));
const party = (id: string, name: string): Party => ({ kind: "codex", name, addr: addrOf(id), session: id, mode: null });
const target = (id: string, name: string): Target => ({ kind: "codex", addr: addrOf(id), name, threadId: id });
const claudeParty = (sock: string, session: string, name: string): Party => ({ kind: "claude", name, addr: encodeAddress(sock), session, mode: null });
const op = async <T>(name: string, req: Record<string, unknown> = {}): Promise<T> => {
  const reply: unknown = await broker.dispatch({ op: name, ...req });
  if (reply && typeof reply === "object" && "result" in reply) return reply.result as T;
  throw new Error(`op ${name} returned no result`);
};
const route = (from: Party, to: Target, body: string, urgency: "normal" | "fyi" | "urgent" = "normal") => broker.routeSend({ msgId: randomUUID(), from, to, body, urgency });

before(async () => {
  mkdirSync(process.env.AGENTSOCKS_CCSOCKS_DIR!, { recursive: true });
  chmodSync(process.env.AGENTSOCKS_CCSOCKS_DIR!, 0o700);
  await broker.start();
});
after(async () => {
  await broker.stop();
});

test("notice: a live Codex driver's message is announced as from your driver", async () => {
  await broker.register("w4cnotew", { cwd: "/w/w4cnote", state: "busy" });
  await broker.register("w4cnoted", { cwd: "/w/w4cnote", state: "busy" });
  const boss = broker.store.getThread("w4cnoted")!;
  await op("set_driver", { threadId: "w4cnotew", addr: `uds:${broker.describe(boss).socketPath}`, name: boss.name });
  await route(party("w4cnoted", boss.name), target("w4cnotew", "w"), "build it when ready", "normal");
  const hook = await op<{ context?: string }>("hook", { threadId: "w4cnotew", agent: "codex", event: "SessionStart" });
  assert.match(hook.context ?? "", /your driver/);
  assert.doesNotMatch(hook.context ?? "", /not your driver/);
});

test("notice: a resumed Claude driver's message is still announced as from your driver", async () => {
  await broker.register("w4cresw", { cwd: "/w/w4cres", state: "busy" });
  const pidA = livePid();
  const a: FakeClaude = await fakeClaude("w4cresdriver", pidA, "busy");
  let b: FakeClaude | undefined;
  try {
    await op("set_driver", { threadId: "w4cresw", addr: encodeAddress(a.socketPath), name: "w4cresdriver" });
    await route(claudeParty(a.socketPath, a.sessionId, "w4cresdriver"), target("w4cresw", "w"), "build it before resume", "normal");
    await closeServer(a.server);
    unlinkSync(join(root, "claude-sessions", `${pidA}.json`));
    const pidB = livePid();
    b = await fakeClaude("w4cresdriver", pidB, "busy", `${pidB}.sock`);
    await route(claudeParty(b.socketPath, b.sessionId, "w4cresdriver"), target("w4cresw", "w"), "build it after resume", "normal");
    const hook = await op<{ context?: string }>("hook", { threadId: "w4cresw", agent: "codex", event: "PostToolUse", toolName: "x" });
    assert.match(hook.context ?? "", /your driver/);
    assert.doesNotMatch(hook.context ?? "", /not your driver/);
  } finally {
    if (b) await closeServer(b.server).catch(() => {});
    await closeServer(a.server).catch(() => {});
  }
});

test("downgrade: a resumed Claude driver's urgent keeps its urgency", async () => {
  await broker.register("w4curgw", { cwd: "/w/w4curg", state: "busy" });
  const pidA = livePid();
  const a: FakeClaude = await fakeClaude("w4curgdriver", pidA, "busy");
  let b: FakeClaude | undefined;
  try {
    await op("set_driver", { threadId: "w4curgw", addr: encodeAddress(a.socketPath), name: "w4curgdriver" });
    const before = await route(claudeParty(a.socketPath, a.sessionId, "w4curgdriver"), target("w4curgw", "w"), "urgent before resume", "urgent");
    assert.equal(before.decision.urgency, "urgent");
    await closeServer(a.server);
    unlinkSync(join(root, "claude-sessions", `${pidA}.json`));
    const pidB = livePid();
    b = await fakeClaude("w4curgdriver", pidB, "busy", `${pidB}.sock`);
    const first = await route(claudeParty(b.socketPath, b.sessionId, "w4curgdriver"), target("w4curgw", "w"), "urgent after resume", "urgent");
    assert.equal(first.decision.urgency, "urgent", "a raw addr compare would downgrade the resumed driver to normal");
    assert.notEqual(first.decision.rule, "not-from-driver");
    assert.equal(broker.store.getOutbox(first.msgId)!.urgency, "urgent");
  } finally {
    if (b) await closeServer(b.server).catch(() => {});
    await closeServer(a.server).catch(() => {});
  }
});

test("peer_status: a caller whose allowlist excludes the driver never sees its name", async () => {
  await broker.register("w4cvisb", { cwd: "/w/w4cvis", state: "busy" });
  await broker.register("w4cvisw", { cwd: "/w/w4cvis", state: "busy" });
  const boss = broker.store.getThread("w4cvisb")!;
  const worker = broker.store.getThread("w4cvisw")!;
  await op("set_driver", { threadId: "w4cvisw", addr: `uds:${broker.describe(boss).socketPath}`, name: boss.name });
  const state = gatewayState(broker.store);
  const row = state.insertPeer({ id: "w4ctok", thread_id: "r-w4ctokenpeer0001", name: "w4ctoken", via: "token", machine: null, login: null, may_message: JSON.stringify([worker.name]), detail: "" });
  const caller: Caller = { peer: row, via: "token", surface: "private", toolset: "full" };
  try {
    const names = (await visiblePeers(broker, caller)).map((p) => p.name);
    assert.ok(names.includes(worker.name));
    assert.ok(!names.includes(boss.name), "the fixture really hides the driver from this caller");
    const to = { kind: "codex" as const, addr: encodeAddress(threadSocketPath("w4cvisw")), name: worker.name, threadId: "w4cvisw" };
    const raw = await op<PeerStatus>("peer_status", { to });
    assert.equal(raw.peer.driver, boss.name, "the op still reports the driver to callers allowed to see it");
    assert.equal(formatPeerStatus(raw, Date.now()).includes(`driver: @${boss.name}`), true);
    assert.equal(formatPeerStatus(raw, Date.now(), names).includes("driver:"), false, "the gateway line names the driver only when visible to the caller");
    const ref = broker.peerRef(to);
    assert.equal(peerStatus(broker.store, ref, Date.now(), names).peer.driver, undefined);
    assert.equal(peerStatus(broker.store, ref, Date.now()).peer.driver, boss.name);
    state.updatePeer(row.id, { may_message: JSON.stringify([worker.name, boss.name]) });
    const wider = (await visiblePeers(broker, { ...caller, peer: state.getPeer(row.id)! })).map((p) => p.name);
    assert.ok(formatPeerStatus(raw, Date.now(), wider).includes(`driver: @${boss.name}`), "an allowlisted driver is still named");
  } finally {
    state.deletePeer(row.id);
  }
});

test("a sender whose view excludes the driver is never told its name", async () => {
  await broker.register("w4cd4w", { cwd: "/w/w4cd4", state: "busy" });
  await broker.register("w4cd4b", { cwd: "/w/w4cd4", state: "busy" });
  await broker.register("w4cd4s", { cwd: "/w/w4cd4", state: "busy" });
  const boss = broker.store.getThread("w4cd4b")!;
  await op("set_driver", { threadId: "w4cd4w", addr: `uds:${broker.describe(boss).socketPath}`, name: boss.name });
  const r = await route(party("w4cd4s", "stranger"), target("w4cd4w", "worker"), "one more request", "normal");
  assert.equal(r.decision.rule, "not-from-driver");
  assert.match(deliveryNote(r, "normal"), new RegExp(`works for ${boss.name} and may not act`));
  const hidden = deliveryNote(r, "normal", ["stranger", "worker"]);
  assert.doesNotMatch(hidden, new RegExp(boss.name), "the driver name stays out of views that cannot list it");
  assert.match(hidden, /works for its driver and may not act/);
  assert.match(deliveryNote(r, "normal", ["stranger", "worker", boss.name]), new RegExp(`Ask ${boss.name} if you need`));
});

test("send: the routed note follows the peers the caller was given", async () => {
  const me = await codexIdentity("w4cd4s");
  const worker = broker.store.getThread("w4cd4w")!;
  const boss = broker.store.getThread("w4cd4b")!;
  const all = await listPeers({});
  const narrow = all.filter((p) => p.name !== boss.name);
  assert.ok(narrow.some((p) => p.name === worker.name) && !narrow.some((p) => p.name === boss.name));
  const gated = await sendMessage(me, worker.name, "do the gated thing", narrow, { urgency: "normal" });
  assert.equal(gated.delivered, true);
  assert.doesNotMatch(gated.note, new RegExp(boss.name));
  const open = await sendMessage(me, worker.name, "do the open thing", all, { urgency: "normal" });
  assert.match(open.note, new RegExp(boss.name));
});

test("live: a renamed Claude driver shows its current name, not the bind-time snapshot", async () => {
  await broker.register("w4cz5w", { cwd: "/w/w4cz5", state: "busy" });
  const pid = livePid();
  const a: FakeClaude = await fakeClaude("w4cz5old", pid, "busy");
  try {
    await op("set_driver", { threadId: "w4cz5w", addr: encodeAddress(a.socketPath), name: "w4cz5old" });
    assert.equal(broker.describe(broker.store.getThread("w4cz5w")!).driver, "w4cz5old");
    writeFileSync(join(root, "claude-sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: a.sessionId, cwd: "/work/w4cz5old", name: "w4cz5new", messagingSocketPath: a.socketPath, kind: "interactive", status: "busy" }));
    assert.equal(broker.describe(broker.store.getThread("w4cz5w")!).driver, "w4cz5new", "headings follow the live Claude name, not the snapshot");
    const ref = broker.peerRef({ kind: "codex", addr: addrOf("w4cz5w"), name: broker.store.getThread("w4cz5w")!.name, threadId: "w4cz5w" });
    assert.equal(peerStatus(broker.store, ref, Date.now()).peer.driver, "w4cz5new");
  } finally {
    await closeServer(a.server).catch(() => {});
  }
});

test("fallback: a departed Claude driver keeps its snapshot name", async () => {
  await broker.register("w4cz5fw", { cwd: "/w/w4cz5f", state: "busy" });
  const pid = livePid();
  const a: FakeClaude = await fakeClaude("w4cz5gone", pid, "busy");
  await op("set_driver", { threadId: "w4cz5fw", addr: encodeAddress(a.socketPath), name: "w4cz5gone" });
  assert.equal(broker.describe(broker.store.getThread("w4cz5fw")!).driver, "w4cz5gone");
  await closeServer(a.server).catch(() => {});
  unlinkSync(join(root, "claude-sessions", `${pid}.json`));
  assert.equal(broker.describe(broker.store.getThread("w4cz5fw")!).driver, "w4cz5gone", "with no live session the bind-time snapshot is the documented fallback");
});
