import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { findCodexThread } from "../src/codexstate.ts";

const broker = new Broker({ wakeEnabled: false, ttyScan: () => [] });
const id = (n: number) => `0199ffff-0000-7000-8000-${String(n).padStart(12, "0")}`;
const ABSENT = id(1);
const SPAWN = id(2);
const NO_COLUMNS = id(3);
const stateDb = (n: number) => join(process.env.CODEX_HOME!, `state_${n}.sqlite`);

async function openState(n: number) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(stateDb(n));
}

before(async () => {
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  const db = await openState(5);
  db.exec(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, approval_mode TEXT, updated_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, source TEXT NOT NULL, thread_source TEXT, first_user_message TEXT NOT NULL DEFAULT '')",
  );
  db.prepare("INSERT INTO threads (id, name, cwd, approval_mode, updated_at_ms, source, thread_source, first_user_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(SPAWN, "spawn", "/work/spawn", "never", Date.now(), "cli", "subagent", "x");
  db.close();
  await broker.start();
});

after(() => broker.stop());

test("a thread absent from the state DB is stored as not a subagent and is not looked up again", async () => {
  await broker.hook({ threadId: ABSENT, event: "SessionStart", cwd: "/work/absent", permissionMode: "default" });
  assert.equal(broker.store.getThread(ABSENT)!.subagent, 0);
  const db = await openState(5);
  db.prepare("INSERT INTO threads (id, name, cwd, approval_mode, updated_at_ms, source, thread_source, first_user_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(ABSENT, "absent", "/work/absent", "never", Date.now(), "cli", "subagent", "x");
  db.close();
  for (let i = 0; i < 3; i++) await broker.hook({ threadId: ABSENT, event: "PostToolUse", toolName: "shell" });
  assert.equal((await findCodexThread({ id: ABSENT }))?.subagent, true, "the state DB now says subagent");
  assert.equal(broker.store.getThread(ABSENT)!.subagent, 0, "the stored answer stands: one lookup per thread");
});

test("a subagent already stored as one stays one when a later lookup cannot find it", async () => {
  await broker.hook({ threadId: SPAWN, event: "SessionStart", cwd: "/work/spawn" });
  assert.equal(broker.store.getThread(SPAWN)!.subagent, 1);
  const db = await openState(5);
  db.prepare("DELETE FROM threads WHERE id = ?").run(SPAWN);
  db.close();
  broker.store.updateThread(SPAWN, { mode: null });
  await broker.register(SPAWN, {});
  assert.equal(broker.store.getThread(SPAWN)!.subagent, 1);
});

test("a state DB with neither thread_source nor source cannot classify a thread, so it is stored as not a subagent", async () => {
  const db = await openState(6);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, approval_mode TEXT, updated_at_ms INTEGER)");
  db.prepare("INSERT INTO threads (id, name, cwd, approval_mode, updated_at_ms) VALUES (?, ?, ?, ?, ?)").run(NO_COLUMNS, "no-columns", "/work/no-columns", "never", Date.now());
  db.close();
  assert.equal((await findCodexThread({ id: NO_COLUMNS }))?.subagent, undefined, "the lookup finds the thread and cannot classify it");
  await broker.hook({ threadId: NO_COLUMNS, event: "SessionStart", cwd: "/work/no-columns" });
  assert.equal(broker.store.getThread(NO_COLUMNS)!.subagent, 0);
});
