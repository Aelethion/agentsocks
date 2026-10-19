import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { RESOLVABLE, codexIdentity, listPeers, resolvePeer } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";

const broker = new Broker({ wakeEnabled: false, ttyScan: () => [] });
const id = (n: number) => `0199dddd-0000-7000-8000-${String(n).padStart(12, "0")}`;
const PARENT = id(1);
const SUB = id(2);
const SOLO = id(3);
const TWIN_A = id(4);
const TWIN_B = id(5);

before(async () => {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  const db = new DatabaseSync(join(process.env.CODEX_HOME!, "state_5.sqlite"));
  db.exec(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, approval_mode TEXT, updated_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, source TEXT NOT NULL, thread_source TEXT, first_user_message TEXT NOT NULL DEFAULT '')",
  );
  const insert = db.prepare("INSERT INTO threads (id, name, cwd, approval_mode, updated_at_ms, source, thread_source, first_user_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const now = Date.now();
  insert.run(PARENT, null, "/work/proj", "never", now - 1000, "cli", "user", "do the thing");
  insert.run(SUB, null, "/work/proj", "never", now - 500, "cli", "subagent", "sub task");
  insert.run(SOLO, null, "/work/solo", "never", now - 400, "cli", "subagent", "solo task");
  insert.run(TWIN_A, null, "/work/twin", "never", now - 300, "cli", "subagent", "twin a");
  insert.run(TWIN_B, null, "/work/twin", "never", now - 200, "cli", "subagent", "twin b");
  db.close();
  await broker.start();
  for (const [threadId, cwd] of [[PARENT, "/work/proj"], [SUB, "/work/proj"], [SOLO, "/work/solo"], [TWIN_A, "/work/twin"], [TWIN_B, "/work/twin"]] as const) {
    await broker.hook({ threadId, event: "SessionStart", cwd });
  }
});

after(() => broker.stop());

test("a hidden subagent that shares its parent's default name does not make the parent's visible name ambiguous", async () => {
  const listed = await listPeers({ includeUnconnected: true });
  assert.ok(!listed.some((p) => p.session === SUB), "the subagent is not listed");
  const visible = listed.find((p) => p.session === PARENT)!.name;
  assert.equal(broker.store.getThread(SUB)!.name, visible, "the two share a name");
  const me = await codexIdentity("thread-n2-sender", "/work/n2-sender");
  const sent = await sendMessage(me, visible, "hello parent");
  assert.equal(sent.to.session, PARENT);
  assert.ok(sent.delivered);
});

test("the shadowed subagent still resolves by thread id and by ref", async () => {
  const everyone = await listPeers(RESOLVABLE);
  const sub = everyone.find((p) => p.session === SUB)!;
  assert.equal(sub.subagent, true);
  assert.equal(resolvePeer(everyone, SUB).session, SUB);
  assert.equal(resolvePeer(everyone, sub.ref).session, SUB);
  const me = await codexIdentity("thread-n2-sender", "/work/n2-sender");
  for (const target of [SUB, sub.ref]) {
    const sent = await sendMessage(me, target, `hello ${target}`);
    assert.equal(sent.to.session, SUB, target);
    assert.ok(sent.delivered, target);
  }
});

test("a subagent resolves by name when no other session has that name", async () => {
  const everyone = await listPeers(RESOLVABLE);
  const name = broker.store.getThread(SOLO)!.name;
  assert.equal(resolvePeer(everyone, name).session, SOLO);
});

test("two subagents sharing a name with no other session of that name are still ambiguous", async () => {
  const everyone = await listPeers(RESOLVABLE);
  const name = broker.store.getThread(TWIN_A)!.name;
  assert.equal(broker.store.getThread(TWIN_B)!.name, name);
  assert.throws(() => resolvePeer(everyone, name), /matches 2 sessions/);
  assert.equal(resolvePeer(everyone, TWIN_A).session, TWIN_A);
});
