import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { codexIdentity, listPeers, resolvePeer, type Peer } from "../src/peers.ts";
import { resolveTarget, sendMessage } from "../src/send.ts";

const broker = new Broker({ wakeEnabled: false, ttyScan: () => [] });
const DAY = 86_400_000;
const id = (n: number) => `0199ffff-0000-7000-8000-${String(n).padStart(12, "0")}`;
const OLD = id(1);
const FRESH = id(2);
const ALONE = id(3);
const TWIN_STALE = id(4);
const TWIN_LIVE = id(5);

const queuedFor = (thread: string) => Number((broker.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_thread = ?").get(thread) as { n: number }).n);

before(async () => {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  const db = new DatabaseSync(join(process.env.CODEX_HOME!, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, approval_mode TEXT, updated_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, source TEXT NOT NULL, thread_source TEXT, first_user_message TEXT NOT NULL DEFAULT '')");
  const insert = db.prepare("INSERT INTO threads (id, name, cwd, approval_mode, updated_at_ms, source, thread_source, first_user_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const now = Date.now();
  insert.run(OLD, "WORKER", "/w/old", "never", now - 3 * DAY, "cli", "user", "old task");
  insert.run(FRESH, "WORKER", "/w/fresh", "never", now - 1000, "cli", "user", "fresh task");
  insert.run(ALONE, "LONELY", "/w/alone", "never", now - 3 * DAY, "cli", "user", "alone");
  insert.run(TWIN_STALE, "TWIN", "/w/twin-old", "never", now - 3 * DAY, "cli", "user", "twin old");
  insert.run(TWIN_LIVE, "TWIN", "/w/twin-live", "never", now - 1000, "cli", "user", "twin live");
  db.close();
  await broker.start();
  for (const [thread, cwd] of [[OLD, "/w/old"], [ALONE, "/w/alone"], [TWIN_STALE, "/w/twin-old"], [TWIN_LIVE, "/w/twin-live"]] as const) {
    await broker.hook({ threadId: thread, event: "SessionStart", cwd });
  }
  broker.store.updateThread(OLD, { last_seen: Date.now() - 3 * DAY });
  broker.store.updateThread(ALONE, { last_seen: Date.now() - 3 * DAY });
  broker.store.updateThread(TWIN_STALE, { last_seen: Date.now() - 3 * DAY });
});

after(() => broker.stop());

test("a stale thread does not win its name over an unconnected one, and the send is refused as ambiguous with both refs", async () => {
  const peers = await listPeers({ includeStale: true, includeUnconnected: true });
  const named = peers.filter((p) => p.name === "WORKER");
  assert.deepEqual(named.map((p) => [p.session, p.connected, p.status]).sort(), [[FRESH, false, "not connected"], [OLD, true, "stale"]].sort());
  const me = await codexIdentity("thread-m1-sender", "/w/sender");
  await assert.rejects(sendMessage(me, "WORKER", "please rerun the failing test"), (err: Error) => {
    assert.match(err.message, /"WORKER" matches 2 sessions/);
    for (const p of named) assert.ok(err.message.includes(`[${p.ref}]`), `${p.ref} named in ${err.message}`);
    return true;
  });
  assert.equal(queuedFor(OLD), 0, "nothing went to the stale thread");
  assert.equal(queuedFor(FRESH), 0, "nothing adopted the fresh one");
  assert.equal(broker.store.getThread(FRESH), undefined);
});

test("a live connected thread still wins a name over a stale one, and a lone stale thread still resolves", async () => {
  const peers = await listPeers({ includeStale: true, includeUnconnected: true });
  const me = await codexIdentity("thread-m1-sender", "/w/sender");
  assert.equal((await resolveTarget(peers, "TWIN", me)).session, TWIN_LIVE);
  assert.equal((await resolveTarget(peers, "LONELY", me)).session, ALONE);
});

test("among stale and unconnected peers of one name nothing wins, whichever order they are listed in", () => {
  const peer = (session: string, extra: Partial<Peer>): Peer => ({ kind: "codex", name: "SAME", ref: session.slice(-6), socketPath: `/run/t/${session}.sock`, session, ...extra });
  const stale = peer("aaaaaaaaaaaa", { connected: true, status: "stale" });
  const unconnected = peer("bbbbbbbbbbbb", { connected: false, status: "not connected" });
  const live = peer("cccccccccccc", { connected: true, status: "idle" });
  assert.throws(() => resolvePeer([stale, unconnected], "SAME"), /matches 2 sessions/);
  assert.throws(() => resolvePeer([unconnected, stale], "SAME"), /matches 2 sessions/);
  assert.equal(resolvePeer([unconnected, stale, live], "SAME").session, live.session);
  assert.equal(resolvePeer([stale, unconnected, live], "SAME").session, live.session);
});
