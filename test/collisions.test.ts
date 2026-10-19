import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { codexIdentity, listPeers, resolvePeer } from "../src/peers.ts";
import { resolveTarget, sendMessage } from "../src/send.ts";

const broker = new Broker({ wakeEnabled: false, ttyScan: () => [] });
const HOUR = 3_600_000;
const id = (n: number) => `0199dddd-0000-7000-8000-${String(n).padStart(12, "0")}`;
const LIVE = id(1);
const OLD_SAME_NAME = id(2);
const LAST = id(90);
let db: DatabaseSync;
const now = Date.now();
const insert = (threadId: string, name: string | null, ageMs: number, source = "cli", threadSource: string | null = "user") =>
  db.prepare("INSERT INTO threads (id, name, cwd, approval_mode, updated_at_ms, source, thread_source, first_user_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(threadId, name, "/work/fe", "never", now - ageMs, source, threadSource, "a task");

before(async () => {
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  db = new DatabaseSync(join(process.env.CODEX_HOME!, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, approval_mode TEXT, updated_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, source TEXT NOT NULL, thread_source TEXT, first_user_message TEXT NOT NULL DEFAULT '')");
  insert(LIVE, "frontend", 1000);
  insert(OLD_SAME_NAME, "frontend", 3000);
  insert("../../../etc/evil", "pathy", 2000);
  insert("a/b", "slashy", 2000);
  insert("0199dddd-live-thread", "wordy", 2000);
  for (let i = 0; i < 600; i++) insert(`0199eeee-0000-7000-8000-${String(i).padStart(12, "0")}`, `spawn-${i}`, 100 + i, "cli", "subagent");
  for (let i = 3; i <= 90; i++) insert(id(i), `plain-${i}`, 5000 + i);
  await broker.start();
  await broker.hook({ threadId: LIVE, event: "SessionStart", cwd: "/work/fe" });
  await broker.dispatch({ op: "set_name", threadId: LIVE, name: "frontend" });
});

after(async () => {
  db.close();
  await broker.stop();
});

test("an unconnected thread with the same name as a connected peer does not make the name ambiguous", async () => {
  const me = await codexIdentity("thread-k10-sender", "/work/k10-sender");
  const peers = await listPeers({ includeUnconnected: true });
  assert.ok(peers.some((p) => p.session === OLD_SAME_NAME && p.connected === false));
  assert.equal((await resolveTarget(undefined, "frontend", me)).session, LIVE);
  assert.equal(resolvePeer(peers, OLD_SAME_NAME, me).session, OLD_SAME_NAME, "the old one is still reachable by its id");
  assert.equal(resolvePeer(peers, "frontend", me).session, LIVE);
  const r = await sendMessage(me, "frontend", "which one?");
  assert.equal(r.to.session, LIVE);
});

test("two unconnected threads with one name stay ambiguous", async () => {
  const me = await codexIdentity("thread-k10-sender", "/work/k10-sender");
  const peers = (await listPeers({ includeUnconnected: true })).filter((p) => p.connected === false);
  assert.ok(peers.some((p) => p.name === "plain-10"));
  insert(id(95), "plain-10", 4990);
  const withTwin = await listPeers({ includeUnconnected: true });
  assert.equal(withTwin.filter((p) => p.name === "plain-10").length, 2);
  await assert.rejects(resolveTarget(withTwin, "plain-10", me), /matches 2 sessions/);
  db.prepare("DELETE FROM threads WHERE id = ?").run(id(95));
});

test("ids that are not Codex thread ids are never listed or resolved", async () => {
  const me = await codexIdentity("thread-k10-sender", "/work/k10-sender");
  const peers = await listPeers({ includeUnconnected: true });
  for (const bad of ["../../../etc/evil", "a/b", "0199dddd-live-thread"]) assert.ok(!peers.some((p) => p.session === bad), `${bad} is not listed`);
  for (const target of ["pathy", "slashy", "wordy", "../../../etc/evil", "a/b"]) await assert.rejects(resolveTarget(undefined, target, me), /no running session/, target);
});

test("at most 50 unconnected threads are listed, and 600 newer subagents do not crowd real ones out", async () => {
  const peers = await listPeers({ includeUnconnected: true });
  const unconnected = peers.filter((p) => p.connected === false);
  assert.equal(unconnected.length, 50);
  assert.ok(unconnected.every((p) => !p.name.startsWith("spawn-")));
  assert.ok(unconnected.some((p) => p.session === OLD_SAME_NAME));
  assert.ok(unconnected.some((p) => p.session === id(3)));
  assert.ok(!unconnected.some((p) => p.session === LAST), "the cap cuts the oldest, after filtering");
});

test("the unconnected listing is read from the Codex state at most once in 5 seconds", async () => {
  const before = process.env.AGENTSOCKS_UNCONNECTED_CACHE_MS;
  try {
    process.env.AGENTSOCKS_UNCONNECTED_CACHE_MS = "5000";
    await listPeers({ includeUnconnected: true });
    insert(id(99), "CACHED-OUT", 10);
    assert.ok(!(await listPeers({ includeUnconnected: true })).some((p) => p.name === "CACHED-OUT"), "served from the cache");
    process.env.AGENTSOCKS_UNCONNECTED_CACHE_MS = "0";
    assert.ok((await listPeers({ includeUnconnected: true })).some((p) => p.name === "CACHED-OUT"), "read again once the cache is not wanted");
  } finally {
    process.env.AGENTSOCKS_UNCONNECTED_CACHE_MS = before;
  }
});

test("a thread adopted while the listing is cached is a connected peer at once, not listed twice", async () => {
  const before = process.env.AGENTSOCKS_UNCONNECTED_CACHE_MS;
  try {
    process.env.AGENTSOCKS_UNCONNECTED_CACHE_MS = "5000";
    const me = await codexIdentity("thread-k10-sender", "/work/k10-sender");
    await listPeers({ includeUnconnected: true });
    await sendMessage(me, id(20), "adopt it");
    const peers = await listPeers({ includeUnconnected: true });
    const entries = peers.filter((p) => p.session === id(20));
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.connected, true);
  } finally {
    process.env.AGENTSOCKS_UNCONNECTED_CACHE_MS = before;
  }
});
