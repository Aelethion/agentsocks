import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { codexIdentity, listPeers, resolvePeer } from "../src/peers.ts";
import { findCodexThread, recentCodexThreads } from "../src/codexstate.ts";
import { resolveTarget, sendMessage } from "../src/send.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const broker = new Broker({ wakeEnabled: false, ttyScan: () => [] });
const HOUR = 3_600_000;
const id = (n: number) => `0199cccc-0000-7000-8000-${String(n).padStart(12, "0")}`;
const USER = id(1);
const SPAWNED = id(2);
const SPAWNED_BY_SOURCE = id(3);
const REVIEWER = id(4);
const NO_PROMPT = id(5);
const ARCHIVED = id(6);
const REGISTERED_SPAWN = id(7);
const ARCHIVED_AT = id(8);
const spawnSource = JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: USER, depth: 1 } } });

before(async () => {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  const db = new DatabaseSync(join(process.env.CODEX_HOME!, "state_5.sqlite"));
  db.exec(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, approval_mode TEXT, updated_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, source TEXT NOT NULL, thread_source TEXT, first_user_message TEXT NOT NULL DEFAULT '', has_user_event INTEGER NOT NULL DEFAULT 0)",
  );
  const insert = db.prepare("INSERT INTO threads (id, name, cwd, approval_mode, updated_at_ms, archived, source, thread_source, first_user_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const now = Date.now();
  insert.run(USER, "WORKER", "/work/worker", "never", now - HOUR, 0, "cli", "user", "fix the build");
  insert.run(SPAWNED, "codex-01a120e6 reviewer", "/work/worker", "never", now - 60_000, 0, "cli", "subagent", "review the diff");
  insert.run(SPAWNED_BY_SOURCE, "source-only-spawn", "/work/worker", "never", now - 61_000, 0, spawnSource, null, "look at the logs");
  insert.run(REVIEWER, "review-spawn", "/work/worker", "never", now - 62_000, 0, JSON.stringify({ subagent: "review" }), null, "check it");
  insert.run(NO_PROMPT, "OPENED-NOT-USED", "/work/empty", "never", now - 63_000, 0, "cli", "user", "");
  insert.run(ARCHIVED, "ARCHIVED-WORKER", "/work/old", "never", now - 64_000, 1, "cli", "user", "an old task");
  insert.run(REGISTERED_SPAWN, "registered-spawn", "/work/worker", "never", now - 65_000, 0, "cli", "subagent", "i have hooks");
  insert.run(ARCHIVED_AT, "ARCHIVED-BY-DATE", "/work/old", "never", now - 66_000, 0, "cli", "user", "an older task");
  db.prepare("UPDATE threads SET archived_at = ? WHERE id = ?").run(now - 1000, ARCHIVED_AT);
  db.close();
  await broker.start();
  await broker.hook({ threadId: REGISTERED_SPAWN, event: "SessionStart", cwd: "/work/worker" });
});

after(() => broker.stop());

test("only user-facing Codex threads are listed as not connected: subagents, threads nobody typed into and archived ones are not", async () => {
  const peers = await listPeers({ includeUnconnected: true });
  const unconnected = peers.filter((p) => p.connected === false);
  assert.deepEqual(unconnected.map((p) => p.name), ["WORKER"]);
  assert.equal(unconnected[0]!.session, USER);
  const direct = await recentCodexThreads(Date.now() - 12 * HOUR);
  assert.deepEqual(direct.map((t) => t.id), [USER]);
});

test("a subagent thread does not resolve as a send target, by id or by name", async () => {
  const me = await codexIdentity("thread-k1-sender", "/work/k1-sender");
  for (const target of [SPAWNED, "codex-01a120e6 reviewer", SPAWNED_BY_SOURCE, "source-only-spawn", REVIEWER, "review-spawn", NO_PROMPT, "OPENED-NOT-USED"]) {
    await assert.rejects(resolveTarget(undefined, target, me), /no running session/, target);
  }
  assert.equal(broker.store.getThread(SPAWNED), undefined, "nothing was registered on the way");
  assert.equal(broker.store.getThread(SPAWNED_BY_SOURCE), undefined);
});

test("a user thread still resolves and is adopted by name, and a subagent that registered through its own hooks stays reachable", async () => {
  const me = await codexIdentity("thread-k1-sender", "/work/k1-sender");
  const adopted = await sendMessage(me, "worker", "hello");
  assert.equal(adopted.to.session, USER);
  assert.ok(broker.store.getThread(USER), "adopted");
  const registered = await sendMessage(me, "registered-spawn", "hello spawn");
  assert.equal(registered.to.session, REGISTERED_SPAWN);
  assert.equal((await resolveTarget(undefined, REGISTERED_SPAWN, me)).session, REGISTERED_SPAWN);
});

test("an archived Codex thread, by flag or by archived_at, does not resolve as a send target by name or id", async () => {
  const me = await codexIdentity("thread-m3-sender", "/work/m3-sender");
  for (const target of [ARCHIVED, "ARCHIVED-WORKER", ARCHIVED_AT, "ARCHIVED-BY-DATE"]) {
    await assert.rejects(resolveTarget(undefined, target, me), /no running session/, target);
    assert.equal(await findCodexThread(/^0199/.test(target) ? { id: target } : { name: target }, { userFacingOnly: true }), undefined, target);
  }
  assert.equal(broker.store.getThread(ARCHIVED), undefined, "nothing was registered on the way");
  assert.equal(broker.store.getThread(ARCHIVED_AT), undefined);
});

test("the lookup a hook registration uses still reads an archived thread's metadata", async () => {
  assert.equal((await findCodexThread({ id: ARCHIVED }))?.name, "ARCHIVED-WORKER");
  assert.equal((await findCodexThread({ id: ARCHIVED_AT }))?.name, "ARCHIVED-BY-DATE");
});

test("a subagent that registered through its own hooks is not listed, as connected or otherwise, by the listing or the CLI", async () => {
  assert.equal(broker.store.getThread(REGISTERED_SPAWN)!.subagent, 1);
  for (const opts of [{}, { includeStale: true }, { includeUnconnected: true }, { includeStale: true, includeUnconnected: true }]) {
    const listed = await listPeers(opts);
    assert.ok(!listed.some((p) => p.session === REGISTERED_SPAWN || p.name === "registered-spawn"), JSON.stringify(opts));
  }
  const json = JSON.parse((await exec(process.execPath, [cli, "list", "--all", "--json"], { env: { ...process.env }, timeout: 30_000 })).stdout) as { session?: string; name: string }[];
  assert.ok(json.length > 0);
  assert.ok(!json.some((p) => p.session === REGISTERED_SPAWN || p.name === "registered-spawn"));
  const text = (await exec(process.execPath, [cli, "list"], { env: { ...process.env }, timeout: 30_000 })).stdout;
  assert.ok(!text.includes("registered-spawn"), text);
});

test("the hidden subagent stays reachable by its thread id and by its ref", async () => {
  const everyone = await listPeers({ includeStale: true, includeUnconnected: true, includeSubagents: true });
  const spawn = everyone.find((p) => p.session === REGISTERED_SPAWN)!;
  assert.equal(spawn.connected, true);
  assert.equal(resolvePeer(everyone, REGISTERED_SPAWN).session, REGISTERED_SPAWN);
  assert.equal(resolvePeer(everyone, spawn.ref).session, REGISTERED_SPAWN);
  const me = await codexIdentity("thread-m4-sender", "/work/m4-sender");
  for (const target of [REGISTERED_SPAWN, spawn.ref]) {
    const sent = await sendMessage(me, target, `hello ${target}`);
    assert.equal(sent.to.session, REGISTERED_SPAWN, target);
    assert.ok(sent.delivered, target);
  }
});

test("a thread registered before the flag existed is looked up again on its next hook, and a user thread is never hidden", async () => {
  broker.store.updateThread(REGISTERED_SPAWN, { subagent: null });
  await broker.hook({ threadId: REGISTERED_SPAWN, event: "PostToolUse", toolName: "shell" });
  assert.equal(broker.store.getThread(REGISTERED_SPAWN)!.subagent, 1);
  assert.ok(!(await listPeers({ includeStale: true })).some((p) => p.session === REGISTERED_SPAWN));
  assert.equal(broker.store.getThread(USER)!.subagent, 0);
  assert.ok((await listPeers({ includeStale: true })).some((p) => p.session === USER), "the adopted user thread is listed");
});

test("the state lookup tells a subagent thread from a user one by thread_source and by the source key", async () => {
  for (const [thread, expected] of [[SPAWNED, true], [SPAWNED_BY_SOURCE, true], [REVIEWER, true], [REGISTERED_SPAWN, true], [USER, false], [NO_PROMPT, false]] as const) {
    assert.equal((await findCodexThread({ id: thread }))?.subagent, expected, thread);
  }
});
