import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { until, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer, postLines, serveInbox } from "../src/ccsocks.ts";
import { buildEnvelope, decodeAddress, messageContent, parseEnvelope } from "../src/envelope.ts";
import { listPeers, type Me } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";
import { ensureProxy, pruneProxies } from "../src/gateway/federation.ts";
import { gatewayState } from "../src/gateway/state.ts";
import { ensurePeer } from "../src/gateway/remote.ts";
import { visiblePeers } from "../src/gateway/gtools.ts";
import { fakeLocalApi, fakeServe, raw, type FakeLocalApi, type FakeServe } from "./gatewaysupport.ts";
import { tempDir } from "./tmp.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const OWNER = "sam@example.com";
const brokerA = new Broker();
const rootB = tempDir("agentsocks-b-");
let apiB: FakeLocalApi;
let child: ChildProcess;
let serveB: FakeServe;
let aclaude: FakeClaude;
let bclaude: { frames: Record<string, unknown>[]; server: import("node:net").Server; socketPath: string };

const envB = (): NodeJS.ProcessEnv => ({
  ...process.env,
  AGENTSOCKS_RUNTIME_DIR: join(rootB, "run"),
  AGENTSOCKS_STATE_DIR: join(rootB, "state"),
  AGENTSOCKS_CLAUDE_SESSIONS_DIR: join(rootB, "claude-sessions"),
  AGENTSOCKS_CLAUDE_PROJECTS_DIR: join(rootB, "claude-projects"),
  AGENTSOCKS_CCSOCKS_DIR: join(rootB, "cc-socks"),
  AGENTSOCKS_CONFIG: join(rootB, "config", "agentsocks.json"),
  XDG_CONFIG_HOME: join(rootB, "config"),
  CODEX_HOME: join(rootB, "codex-home"),
  AGENTSOCKS_SWEEP_MS: "200",
  TS_SOCKET: apiB.socketPath,
});

function callB(op: string, args: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ path: join(rootB, "run", "broker.sock") });
    let buffer = "";
    sock.setEncoding("utf8");
    sock.on("error", reject);
    sock.on("connect", () => sock.write(`${JSON.stringify({ id: 1, op, ...args })}\n`));
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      const res = JSON.parse(buffer.slice(0, end)) as { ok: boolean; result?: unknown; error?: string; ackRequired?: boolean };
      if (res.ackRequired) sock.write(`${JSON.stringify({ ack: true })}\n`);
      sock.end();
      if (res.ok) resolve(res.result);
      else reject(new Error(res.error));
    });
  });
}

before(async () => {
  process.env.AGENTSOCKS_FED_SYNC_MS = "300";
  apiB = await fakeLocalApi({ login: OWNER, dnsName: "broker-b.tail1234.ts.net" });
  apiB.machines.set("100.64.7.1", { name: "broker-a", login: OWNER, ip: "100.64.7.1" });
  mkdirSync(join(rootB, "claude-sessions"), { recursive: true });
  child = spawn(process.execPath, [cli, "daemon"], { env: envB(), stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    const up = await callB("ping").then(() => true, () => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const on = await callB("gateway_on", { port: 0 });
  serveB = await fakeServe(on.private.port, { login: OWNER, ip: "100.64.7.1" }, {}, "broker-b.tail1234.ts.net");
  const pid = livePid();
  const socketPath = join(rootB, "cc-socks", `${pid}.sock`);
  const frames: Record<string, unknown>[] = [];
  const server = await serveInbox(socketPath, (f) => frames.push(f as Record<string, unknown>));
  writeFileSync(join(rootB, "claude-sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: "bclaude-session", cwd: "/work/bclaude", name: "bclaude", messagingSocketPath: socketPath, kind: "interactive", status: "idle" }));
  bclaude = { frames, server, socketPath };
  await brokerA.start();
  aclaude = await fakeClaude("aclaude", livePid(), "idle");
});

after(async () => {
  await brokerA.stop();
  await closeServer(aclaude.server);
  await closeServer(bclaude.server);
  await serveB.close();
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
  await apiB.close();
});

async function eventually<T>(fn: () => Promise<T | undefined>, failure: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(failure);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const link = () => brokerA.dispatch({ op: "gateway_link", target: serveB.url });
const aMe = (): Me => ({ kind: "claude", name: "aclaude", socketPath: aclaude.socketPath, session: aclaude.sessionId });

test("a machine that has not been allowed is refused, and the refusal says what to run", async () => {
  await assert.rejects(link(), /this machine has not allowed broker-a to link; run: agentsocks gateway allow broker-a/);
  const direct = await raw(serveB.url, "/federation/peers", { method: "POST", headers: { "content-type": "application/json" }, body: '{"peers":[]}' });
  assert.equal(direct.status, 403);
});

test("once allowed, linking exchanges peer lists and each side lists the other's sessions as name@host", async () => {
  await callB("gateway_allow", { host: "broker-a" });
  const made = (await link()).result as { host: string; peers: number };
  assert.deepEqual([made.host, made.peers], ["broker-b", 1]);
  const here = (await listPeers({})).find((p) => p.name === "bclaude@broker-b")!;
  assert.deepEqual([here.kind, here.via, here.machine], ["remote", "tailnet", "broker-b"]);
  const there = (await callB("list_remote_peers")) as { name: string; via: string; machine: string }[];
  assert.ok(there.some((p) => p.name === "aclaude@broker-a" && p.via === "tailnet" && p.machine === "broker-a"));
});

test("a message to name@host is delivered natively on the far broker, from name@here, with no permission mode", async () => {
  const sent = await sendMessage(aMe(), "bclaude@broker-b", "hello from machine A");
  assert.equal(sent.to.kind, "remote");
  const frame = await until(() => bclaude.frames.find((f) => parseEnvelope(messageContent(f))?.body === "hello from machine A"), 8000);
  const env = parseEnvelope(messageContent(frame))!;
  assert.equal(env.fromName, "aclaude@broker-a");
  assert.equal(env.fromMode, undefined);
  assert.equal(bclaude.frames.filter((f) => parseEnvelope(messageContent(f))?.body === "hello from machine A").length, 1, "exactly once");
  const answer = buildEnvelope({ from: "uds:/claude/bclaude", fromName: "bclaude", fromSession: "bclaude-session", body: "hello back from B" });
  await postLines(decodeAddress(env.from!)!, [JSON.stringify({ type: "user", message: { role: "user", content: answer }, priority: "next", from: "uds:/claude/bclaude", msg_id: "b-native-1" })]);
  const back = await until(() => aclaude.frames.find((f) => parseEnvelope(messageContent(f))?.body === "hello back from B"), 8000);
  assert.equal(parseEnvelope(messageContent(back))!.fromName, "bclaude@broker-b");
});

test("a Codex session on the far machine gets it in its inbox, where it reads it with the tool", async () => {
  await callB("register", { threadId: "codex-b-1", cwd: "/work/api-b" });
  const name = ((await callB("list_threads")) as { name: string }[]).find((t) => t.name === "codex-api-b")!.name;
  const found = await eventually(async () => (await listPeers({})).find((x) => x.name === `${name}@broker-b`), "the Codex peer never appeared");
  assert.equal(found.kind, "remote");
  await sendMessage(aMe(), found.name, "ping the codex session");
  const text = await eventually(async () => {
    const r = (await callB("take", { threadId: "codex-b-1" })) as { text: string };
    return r.text.includes("ping the codex session") ? r.text : undefined;
  }, "the message never reached the Codex inbox");
  assert.match(text, /from="@aclaude@broker-a/);
});

test("a message to a session that is gone on the far machine fails, and the sender can see why", async () => {
  await callB("hook", { threadId: "codex-b-1", event: "SessionEnd" });
  const sent = await sendMessage(aMe(), "codex-api-b@broker-b", "are you still there");
  const row = await eventually(async () => {
    const r = brokerA.store.getOutbox(sent.msgId);
    return r && r.status === "failed" ? r : undefined;
  }, "the sender was never told it failed");
  assert.match(row.error ?? "", /codex-api-b/);
});

test("a linked machine can reach the far machine's own sessions and nothing else: not its remote peers, and never as one of its local names", async () => {
  const made = (await callB("gateway_token_add", { name: "bgrok", mayMessage: [] })) as { name: string };
  assert.equal(made.name, "bgrok");
  const post = (body: unknown) => raw(serveB.url, "/federation/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const toRemote = await post({ msgId: "fed-x-1", from: "aclaude", to: "bgrok", body: "relay this to the internet peer" });
  assert.equal(toRemote.status, 404);
  assert.match((toRemote.json() as { error: string }).error, /no running session named "bgrok"/);
  const spoof = await post({ msgId: "fed-x-2", from: "bclaude", to: "bclaude", body: "pretending to be local" });
  assert.equal(spoof.status, 200);
  const frame = await until(() => bclaude.frames.find((f) => parseEnvelope(messageContent(f))?.body === "pretending to be local"));
  assert.equal(parseEnvelope(messageContent(frame))!.fromName, "bclaude@broker-a", "a name a linked machine claims always carries that machine's name");
});

test("a linked machine reaches the far machine's Claude and Codex sessions and not its sessions of other agents: they are neither listed nor reachable", async () => {
  await callB("hook", { threadId: "cursor_fed-1", agent: "cursor", event: "SessionStart", cwd: "/work/fedagent" });
  const post = (path: string, body: unknown) => raw(serveB.url, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const listed = await post("/federation/peers", { peers: [] });
  assert.equal(listed.status, 200);
  const names = (listed.json() as { peers: { name: string }[] }).peers.map((p) => p.name);
  assert.ok(names.includes("bclaude"), names.join(", "));
  assert.ok(!names.includes("cursor-fedagent"), `no agent session in ${names.join(", ")}`);
  const refused = await post("/federation/send", { msgId: "fed-agent-1", from: "aclaude", to: "cursor-fedagent", body: "reach the cursor session" });
  assert.equal(refused.status, 404);
  assert.match((refused.json() as { error: string }).error, /no running session named "cursor-fedagent"/);
  assert.equal(((await callB("take", { threadId: "cursor_fed-1" })) as { count: number }).count, 0, "nothing reached the cursor session");
  assert.equal(((await callB("list_threads")) as { name: string }[]).some((t) => t.name === "cursor-fedagent"), true, "while it is a live session on the far machine");
});

test("a remote peer never sees the far machine's sessions, because it could not use them", async () => {
  const ext = await ensurePeer(brokerA, { id: "token:ext1", name: "ext", via: "token", mayMessage: ["*"] });
  const caller = { peer: ext, via: "token" as const, surface: "public" as const, toolset: "reduced" as const };
  const names = (await visiblePeers(brokerA, caller)).map((p) => p.name);
  assert.ok(names.includes("aclaude"));
  assert.ok(!names.some((n) => n.includes("@")), `no name@host in ${names.join(", ")}`);
  assert.ok((await listPeers({})).some((p) => p.name.endsWith("@broker-b")), "while a local agent still sees them");
});

test("the kill switch pauses forwarding and lifting it sends what waited", async () => {
  const kill = join(process.env.XDG_CONFIG_HOME!, "agentsocks");
  mkdirSync(kill, { recursive: true });
  writeFileSync(join(kill, "off"), "");
  try {
    const proxy = brokerA.store.db.prepare("SELECT thread_id FROM gateway_peers WHERE id = ?").get("fed:broker-b/bclaude") as { thread_id: string };
    brokerA.store.enqueue({ id: "row-kill-1", msg_id: "kill-1", to_thread: proxy.thread_id, kind: "message", from_addr: null, from_name: "aclaude", from_kind: "claude", from_session: null, from_mode: null, body: "queued while switched off", received_at: Date.now() });
    await new Promise((r) => setTimeout(r, 500));
    const quietFrom = serveB.requests.length;
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(serveB.requests.length, quietFrom, "a switched-off link makes no request at all, not even to exchange peer lists");
    assert.ok(!bclaude.frames.some((f) => parseEnvelope(messageContent(f))?.body === "queued while switched off"));
  } finally {
    rmSync(join(kill, "off"), { force: true });
  }
  await until(() => bclaude.frames.find((f) => parseEnvelope(messageContent(f))?.body === "queued while switched off"), 8000);
});

test("a message the far broker could not hand to its session fails for the sender instead of looking delivered", async () => {
  const stalePath = join(rootB, "cc-socks", "stale.sock");
  const holder = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(stalePath)}, () => process.stdout.write("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((r) => holder.stdout!.once("data", r));
  holder.kill("SIGKILL");
  await new Promise((r) => holder.once("exit", r));
  const pid = livePid();
  writeFileSync(join(rootB, "claude-sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: "stale-session", cwd: "/work/stale", name: "stale-b", messagingSocketPath: stalePath, kind: "interactive", status: "idle" }));
  const proxy = await eventually(async () => (await listPeers({})).find((p) => p.name === "stale-b@broker-b"), "the stale session never appeared");
  const sent = await sendMessage(aMe(), proxy.name, "into a dead socket");
  const row = await eventually(async () => {
    const r = brokerA.store.getOutbox(sent.msgId);
    return r && r.status === "failed" ? r : undefined;
  }, "the message never failed");
  assert.match(row.error ?? "", /stale-b@broker-b: .*could not deliver/);
  assert.equal(row.shown_at, null, "it was never shown to anyone");
});

test("a linked machine cannot make this one create more than a bounded number of proxy peers", async () => {
  const names = Array.from({ length: 300 }, (_, i) => ({ name: `flood-${i}`, kind: "claude", status: "idle" }));
  const post = (path: string, body: unknown) => raw(serveB.url, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("/federation/peers", { peers: names })).status, 200);
  const proxies = ((await callB("list_remote_peers")) as { name: string }[]).filter((p) => p.name.endsWith("@broker-a"));
  assert.ok(proxies.length <= 200, `${proxies.length} proxies`);
  const over = await post("/federation/send", { msgId: "fed-flood-1", from: "one-more-label", to: "bclaude", body: "past the limit" });
  assert.equal(over.status, 429);
  assert.match((over.json() as { error: string }).error, /more than 200 sessions/);
});

test("proxies that were not seen for a week and hold nothing unread are hidden, and the ones with something waiting stay", async () => {
  const state = gatewayState(brokerA.store);
  const quiet = await ensureProxy(brokerA, "oldhost", "quiet-ghost");
  const waiting = await ensureProxy(brokerA, "oldhost", "waiting-ghost");
  const old = Date.now() - 8 * 86_400_000;
  state.updatePeer(quiet.id, { last_seen: old });
  state.updatePeer(waiting.id, { last_seen: old });
  brokerA.store.enqueue({ id: "row-ghost-1", msg_id: "ghost-1", to_thread: waiting.thread_id, kind: "message", from_addr: null, from_name: "aclaude", from_kind: "claude", from_session: null, from_mode: null, body: "still waiting", received_at: Date.now() });
  assert.ok(pruneProxies(brokerA) >= 1);
  assert.equal(state.getPeer(quiet.id)!.disabled, 1);
  assert.equal(state.getPeer(waiting.id)!.disabled, 0);
});

test("a machine that is no longer allowed gets 403 and its link reports it", async () => {
  await callB("gateway_allow", { host: "broker-a", allowed: false });
  const direct = await raw(serveB.url, "/federation/pull", {});
  assert.equal(direct.status, 403);
  const status = await eventually(async () => {
    const s = (await brokerA.dispatch({ op: "gateway_status" })).result as { hosts: { host: string; connected?: boolean; error?: string }[] };
    const h = s.hosts.find((x) => x.host === "broker-b");
    return h && h.connected === false && h.error ? h : undefined;
  }, "the link never reported the refusal");
  assert.match(status.error ?? "", /has not allowed broker-a/);
  await callB("gateway_allow", { host: "broker-a" });
});

test("unlinking removes the far machine's sessions from the list", async () => {
  await brokerA.dispatch({ op: "gateway_unlink", host: "broker-b" });
  assert.ok(!(await listPeers({})).some((p) => p.name.endsWith("@broker-b")));
});
