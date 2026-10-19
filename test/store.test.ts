import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, MAX_QUEUED_PER_THREAD, type NewMessage, type NewOutbox } from "../src/store.ts";
import { tempDir } from "./tmp.ts";

const columns = (db: DatabaseSync, table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

function legacyDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE threads (thread_id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT, mode TEXT, state TEXT NOT NULL DEFAULT 'unknown', remote TEXT,
      created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, pending_wake_at INTEGER, wake_log TEXT NOT NULL DEFAULT '[]', stop_streak INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE messages (id TEXT PRIMARY KEY, to_thread TEXT NOT NULL, kind TEXT NOT NULL, from_addr TEXT, from_name TEXT, from_kind TEXT, from_session TEXT,
      from_mode TEXT, body TEXT NOT NULL, received_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued', surfaced_at INTEGER);
  `);
  db.prepare("INSERT INTO threads (thread_id, name, cwd, state, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)").run("t-old", "codex-old", "/w/old", "idle", 1000, 2000);
  db.prepare("INSERT INTO messages (id, to_thread, kind, from_addr, from_name, from_kind, body, received_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "m-old",
    "t-old",
    "message",
    "uds:/x/cc-socks/1.sock",
    "api",
    "claude",
    "written by v0.1",
    3000,
    "notified",
  );
  db.close();
}

test("a v0.1 database migrates in place: old rows survive, new columns default, and reopening changes nothing", () => {
  const path = join(tempDir("agentsocks-store-"), "agentsocks.db");
  legacyDb(path);
  const first = new Store(path);
  const thread = first.getThread("t-old")!;
  assert.equal(thread.name, "codex-old");
  assert.equal(thread.current_task, null);
  assert.equal(thread.last_tool, null);
  assert.equal(thread.last_activity, null);
  assert.equal(thread.wake_hold_since, null);
  assert.equal(thread.subagent, null, "a migrated thread has not been looked up yet");
  const rows = first.peek("t-old", 10_000).messages;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.body, "written by v0.1");
  assert.equal(rows[0]!.route, "now", "legacy messages behave like v0.1 deliveries");
  assert.equal(rows[0]!.decision, null);
  for (const table of ["outbox", "tasks"]) assert.ok(columns(first.db, table).length > 10, `${table} table exists`);
  first.close();
  const second = new Store(path);
  assert.equal(second.peek("t-old", 10_000).messages[0]!.body, "written by v0.1");
  assert.deepEqual(columns(second.db, "threads").filter((c) => ["current_task", "last_tool", "last_activity", "wake_hold_since"].includes(c)).sort(), [
    "current_task",
    "last_activity",
    "last_tool",
    "wake_hold_since",
  ]);
  second.close();
});

const msg = (over: Partial<NewMessage>): NewMessage => ({
  id: "m",
  msg_id: "m",
  to_thread: "t1",
  kind: "message",
  from_addr: null,
  from_name: "x",
  from_kind: "claude",
  from_session: null,
  from_mode: null,
  body: "b",
  received_at: 1,
  ...over,
});

test("held messages are invisible to the inbox until released, and the cap evicts held digests before real messages", () => {
  const s = new Store(":memory:");
  s.upsertThread("t1", {}, "codex-x");
  s.enqueue(msg({ id: "held", msg_id: "held", route: "digest", held: true, received_at: 1 }));
  assert.equal(s.queuedCount("t1"), 0);
  assert.equal(s.peek("t1", 10_000).messages.length, 0);
  assert.equal(s.pendingCount("t1"), 1);
  for (let i = 0; i < MAX_QUEUED_PER_THREAD - 1; i++) s.enqueue(msg({ id: `q${i}`, msg_id: `q${i}`, received_at: 10 + i }));
  assert.equal(s.pendingCount("t1"), MAX_QUEUED_PER_THREAD);
  s.enqueue(msg({ id: "extra", msg_id: "extra", received_at: 9999 }));
  assert.equal(s.db.prepare("SELECT 1 FROM messages WHERE id = 'held'").get(), undefined, "the held digest is evicted first");
  assert.equal(s.queuedCount("t1"), MAX_QUEUED_PER_THREAD, "no real message was lost");
  s.close();
});

test("outbox rows round-trip and are found by their own id or by the carrier message that delivered them", () => {
  const s = new Store(":memory:");
  const row: NewOutbox = {
    id: "o1",
    msg_id: "m1",
    from_addr: "uds:/a",
    from_name: "a",
    from_kind: "codex",
    from_session: "t1",
    from_mode: "bypass",
    to_addr: "uds:/b",
    to_name: "b",
    to_kind: "claude",
    to_thread: null,
    to_session: "s1",
    body: "hello",
    urgency: "normal",
    route: "digest",
    decision: JSON.stringify({ route: "digest" }),
    status: "held",
    task_id: null,
    created_at: 5,
  };
  s.insertOutbox(row);
  assert.equal(s.getOutbox("m1")!.status, "held");
  s.updateOutbox("o1", { status: "sent", carrier_id: "carrier-9", sent_at: 6 });
  assert.equal(s.getOutbox("carrier-9")!.id, "o1");
  assert.equal(s.getOutbox("nope"), undefined);
  s.close();
});
