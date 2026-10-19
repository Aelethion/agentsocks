import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promisify } from "node:util";
import { fakeClaude, livePid, shimmedEnv, until, wakeLog, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { codexIdentity, listPeers, resolvePeer } from "../src/peers.ts";
import { threadSocketPath } from "../src/paths.ts";
import { sendMessage } from "../src/send.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const broker = new Broker({ ttyScan: () => [] });
let claude: FakeClaude;

const HOUR = 3_600_000;
const ENGINEER = "0199aaaa-0000-7000-8000-00000000000a";
const NAMELESS = "0199aaaa-0000-7000-8000-00000000000b";
const ARCHIVED = "0199aaaa-0000-7000-8000-00000000000c";
const STALE = "0199aaaa-0000-7000-8000-00000000000d";
const LIVE = "0199aaaa-0000-7000-8000-00000000000e";
const ARCHIVED_AT = "0199aaaa-0000-7000-8000-00000000000f";
const QUOTED = "0199aaaa-0000-7000-8000-000000000011";

before(async () => {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  const db = new DatabaseSync(join(process.env.CODEX_HOME!, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, approval_mode TEXT, updated_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER)");
  const insert = db.prepare("INSERT INTO threads (id, name, cwd, approval_mode, updated_at_ms, archived, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const now = Date.now();
  insert.run(ENGINEER, "ENGINEER", "/work/engineer", "never", now - HOUR, 0, null);
  insert.run(NAMELESS, null, "/work/nameless", "on-request", now - 2 * HOUR, 0, null);
  insert.run(ARCHIVED, "archived-one", "/work/archived", "never", now - HOUR, 1, null);
  insert.run(ARCHIVED_AT, "archived-by-date", "/work/archived2", "never", now - HOUR, 0, now - 1000);
  insert.run(STALE, "stale-one", "/work/stale", "never", now - 13 * HOUR, 0, null);
  insert.run(LIVE, "LIVE-ONE", "/work/live", "never", now - HOUR, 0, null);
  insert.run(QUOTED, "QUOTED-ONE", '/work/"quoted" dir', "never", now - 3 * HOUR, 0, null);
  for (let i = 0; i < 60; i++) insert.run(`0199bbbb-0000-7000-8000-${String(i).padStart(12, "0")}`, `crowd-${i}`, "/work/crowd", "never", now - 30_000 - i, 0, null);
  db.close();
  await broker.start();
  claude = await fakeClaude("unconnected-claude", livePid(), "busy");
  await broker.hook({ threadId: LIVE, event: "SessionStart", cwd: "/work/live" });
  for (let i = 0; i < 60; i++) broker.store.upsertThread(`0199bbbb-0000-7000-8000-${String(i).padStart(12, "0")}`, {}, `crowd-${i}`);
});

after(async () => {
  await closeServer(claude.server);
  await broker.stop();
});

const names = (peers: { name: string }[]) => peers.map((p) => p.name);

test("a recent, unarchived Codex thread that never registered is listed after the connected ones as not connected", async () => {
  const peers = await listPeers({ includeUnconnected: true });
  const unconnected = peers.filter((p) => p.connected === false);
  assert.deepEqual(names(unconnected).sort(), ["ENGINEER", "QUOTED-ONE", "codex-0199aaaa"].sort(), "60 newer registered threads do not crowd them out");
  assert.equal(peers.find((p) => p.name === "QUOTED-ONE")!.cwd, "/work/quoted dir", "the listed cwd is cleaned"); 
  const firstUnconnected = peers.findIndex((p) => p.connected === false);
  assert.ok(peers.slice(0, firstUnconnected).every((p) => p.connected === true), "connected peers come first");
  assert.ok(peers.slice(firstUnconnected).every((p) => p.connected === false));
  const engineer = peers.find((p) => p.name === "ENGINEER")!;
  assert.deepEqual(
    { kind: engineer.kind, session: engineer.session, cwd: engineer.cwd, status: engineer.status, socketPath: engineer.socketPath, connected: engineer.connected },
    { kind: "codex", session: ENGINEER, cwd: "/work/engineer", status: "not connected", socketPath: threadSocketPath(ENGINEER), connected: false },
  );
  assert.match(engineer.ref, /^[0-9a-f]{6,}$/);
  for (const absent of ["archived-one", "archived-by-date", "stale-one"]) assert.ok(!names(peers).includes(absent), `${absent} is not listed`);
  assert.equal(peers.filter((p) => p.session === LIVE).length, 1, "a registered thread is listed once, as connected");
  assert.equal(peers.find((p) => p.session === LIVE)!.connected, true);
});

test("without includeUnconnected nothing changes for callers that never asked", async () => {
  const peers = await listPeers();
  assert.ok(peers.every((p) => p.connected === true));
  assert.ok(!names(peers).includes("ENGINEER"));
});

test("agentsocks list --json keeps every existing field and value for connected peers, only adds connected, and appends the unconnected ones", async () => {
  const run = async (...args: string[]) => (await exec(process.execPath, [cli, ...args], { env: { ...process.env }, timeout: 30_000 })).stdout;
  const json = JSON.parse(await run("list", "--json")) as Record<string, unknown>[];
  const alpha = json.find((p) => p.name === "unconnected-claude")!;
  assert.deepEqual(Object.keys(alpha).sort(), ["connected", "cwd", "kind", "name", "ref", "session", "socketPath", "status"]);
  assert.deepEqual(
    { kind: alpha.kind, name: alpha.name, session: alpha.session, cwd: alpha.cwd, socketPath: alpha.socketPath, status: alpha.status, connected: alpha.connected },
    { kind: "claude", name: "unconnected-claude", session: "unconnected-claude-session", cwd: "/work/unconnected-claude", socketPath: claude.socketPath, status: "busy", connected: true },
  );
  assert.match(String(alpha.ref), /^[0-9a-f]{6,}$/);
  const live = json.find((p) => p.session === LIVE)!;
  assert.deepEqual(Object.keys(live).sort(), ["connected", "cwd", "kind", "name", "ref", "session", "socketPath", "status"]);
  assert.deepEqual([live.kind, live.cwd, live.connected], ["codex", "/work/live", true]);
  assert.ok(["idle", "busy", "unknown"].includes(String(live.status)), `a connected thread keeps its state as status, saw ${String(live.status)}`);

  const engineer = json.find((p) => p.session === ENGINEER)!;
  assert.deepEqual(Object.keys(engineer).sort(), ["connected", "cwd", "kind", "name", "ref", "session", "socketPath", "status"]);
  assert.equal(engineer.connected, false);

  const connectedRefs = (await listPeers()).map((p) => [p.session ?? p.socketPath, p.ref]);
  const withExtras = (await listPeers({ includeUnconnected: true })).filter((p) => p.connected).map((p) => [p.session ?? p.socketPath, p.ref]);
  assert.deepEqual(withExtras, connectedRefs, "refs of connected peers do not move when unconnected threads are added");

  const text = await run("list");
  assert.match(text, /ENGINEER \[[0-9a-f]+\]\s+codex\s+not connected yet: a message wakes it and it reads with `agentsocks inbox`\s+\/work\/engineer/);
  assert.match(text, /unconnected-claude \[[0-9a-f]+\]\s+claude\s+busy/);
});

test("sending to an unconnected thread by its Codex name registers it, binds its socket and wakes it with the shell instruction", async () => {
  const me = await codexIdentity("thread-j10-sender", "/work/j10-sender");
  const r = await sendMessage(me, "engineer", "are you there?");
  assert.equal(r.to.name, "ENGINEER");
  const thread = broker.store.getThread(ENGINEER)!;
  assert.equal(thread.mode, "bypass", "approval never maps to bypass");
  assert.equal(thread.cwd, "/work/engineer");
  assert.ok(existsSync(threadSocketPath(ENGINEER)), "its inbox socket is bound");
  const log = await until(() => {
    const now = existsSync(wakeLog) ? readFileSync(wakeLog, "utf8") : "";
    return now.includes(ENGINEER) ? now : undefined;
  }, 5000);
  const wake = log.slice(log.lastIndexOf(ENGINEER));
  assert.ok(wake.includes("Read it by running: agentsocks inbox"), wake);
  assert.ok(!wake.includes("are you there?"), "the wake carries no message text");
  const after = await listPeers({ includeUnconnected: true });
  assert.equal(after.filter((p) => p.session === ENGINEER).length, 1);
  assert.equal(after.find((p) => p.session === ENGINEER)!.connected, true, "once adopted it is a connected peer");
});

test("an unconnected thread resolves by Codex name, id and ref like any peer", async () => {
  const peers = await listPeers({ includeUnconnected: true });
  const nameless = peers.find((p) => p.session === NAMELESS)!;
  assert.equal(nameless.connected, false);
  assert.equal(resolvePeer(peers, nameless.name).session, NAMELESS);
  assert.equal(resolvePeer(peers, NAMELESS).session, NAMELESS);
  assert.equal(resolvePeer(peers, nameless.ref).session, NAMELESS);
  const me = await codexIdentity("thread-j10-sender", "/work/j10-sender");
  const r = await sendMessage(me, nameless.ref, "by ref");
  assert.equal(r.to.session, NAMELESS);
  assert.ok(broker.store.getThread(NAMELESS), "adopted by its ref");
  assert.ok(existsSync(threadSocketPath(NAMELESS)));
});

test("a thread whose SessionStart hook fires gets its own socket, apart from an adopted one", async () => {
  const live = await broker.hook({ threadId: LIVE, event: "SessionStart", cwd: "/work/live" });
  assert.ok(live.context);
  const livePath = threadSocketPath(LIVE);
  assert.ok(existsSync(livePath));
  assert.notEqual(livePath, threadSocketPath(ENGINEER));
  const peers = await listPeers({ includeUnconnected: true });
  const paths = peers.filter((p) => p.kind === "codex").map((p) => p.socketPath);
  assert.equal(new Set(paths).size, paths.length, "no two Codex threads share an inbox");
});

test("status of an unconnected thread reports that and does not register it; the raw cwd is kept when a send adopts it", async () => {
  const me = await codexIdentity("thread-j10-sender", "/work/j10-sender");
  const { peerStatus } = await import("../src/ops.ts");
  await assert.rejects(peerStatus(me, "QUOTED-ONE"), /@QUOTED-ONE is not connected yet, so there is no status to show\. A message to it registers it\./);
  assert.equal(broker.store.getThread(QUOTED), undefined, "a status query registers nothing");
  assert.equal((await listPeers({ includeUnconnected: true })).find((p) => p.session === QUOTED)!.connected, false);
  await sendMessage(me, "QUOTED-ONE", "now register it");
  assert.equal(broker.store.getThread(QUOTED)!.cwd, '/work/"quoted" dir', "the DB value, not the cleaned display value");
});

test("doctor lists such threads and says how to give one full tools", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(process.env.CODEX_HOME!, "state_5.sqlite"));
  db.prepare("INSERT INTO threads (id, name, cwd, approval_mode, updated_at_ms, archived) VALUES (?, ?, ?, ?, ?, 0)").run("0199aaaa-0000-7000-8000-000000000010", "LATE-ONE", "/work/late", "never", Date.now() - 60_000);
  db.close();
  let out = "";
  try {
    out = (await exec(process.execPath, [cli, "doctor"], { env: { ...process.env, ...shimmedEnv() }, timeout: 30_000 })).stdout;
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? "";
  }
  assert.match(out, /note: 1 recent Codex thread is not connected yet \(no agentsocks hook has run in it\): LATE-ONE \[[0-9a-f]+\]/);
  assert.match(out, /A message still wakes it and it reads with `agentsocks inbox`\. To give one full tools: close every client attached to it \(its terminal and any `codex agents` dashboard\), wait 60 s with no turn running, then resume it\./);
  assert.ok(!out.includes("ENGINEER"), "adopted threads are not listed as unconnected");
});

test("list_peers on both hosts marks the unconnected thread, and gives no reply address for a socket that is not bound yet", async () => {
  for (const host of ["claude", "codex"] as const) {
    const client = new Client({ name: `test-${host}`, version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--host", host], env: { ...process.env } as Record<string, string> }));
    try {
      const res = (await client.callTool({ name: "list_peers", arguments: {}, ...(host === "codex" && { _meta: { threadId: LIVE } }) })) as { content: { text: string }[] };
      const text = res.content.map((c) => c.text).join("\n");
      assert.match(text, /- LATE-ONE \[[0-9a-f]+\] codex, not connected yet: a message wakes it and it reads with `agentsocks inbox`, \/work\/late/, host);
      assert.ok(!/LATE-ONE[^\n]*\n\s+address:/.test(text), `${host}: no address line for an unbound socket`);
    } finally {
      await client.close();
    }
  }
});
