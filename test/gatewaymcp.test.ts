import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { until, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer, postLines } from "../src/ccsocks.ts";
import { buildEnvelope, decodeAddress, messageContent, parseEnvelope } from "../src/envelope.ts";
import { codexIdentity } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";
import { TOOLS, describeFor } from "../src/tools/index.ts";
import { fakeLocalApi, fakeServe, mcpClient, type FakeLocalApi, type FakeServe } from "./gatewaysupport.ts";

const broker = new Broker();
let api: FakeLocalApi;
let serve: FakeServe;
let client: Client;
let alpha: FakeClaude;

const call = async (name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args, ...(meta && { _meta: meta }) });
  return { text: (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n"), isError: r.isError === true };
};

async function readUntil(wanted: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const r = await call("read_inbox");
    if (r.text.includes(wanted)) return r.text;
    await new Promise((res) => setTimeout(res, 30));
  }
  throw new Error(`"${wanted}" never arrived`);
}

before(async () => {
  api = await fakeLocalApi();
  process.env.TS_SOCKET = api.socketPath;
  api.machines.set("100.64.1.1", { name: "hetzner-lab", login: "sam@example.com", ip: "100.64.1.1" });
  await broker.start();
  alpha = await fakeClaude("alpha", livePid(), "idle");
  const on = (await broker.dispatch({ op: "gateway_on", port: 0 })).result as { private: { port: number } };
  serve = await fakeServe(on.private.port, { login: "sam@example.com", ip: "100.64.1.1" });
  client = await mcpClient(serve.url);
});

after(async () => {
  await client.close();
  await serve.close();
  await closeServer(alpha.server);
  await broker.stop();
  await api.close();
});

test("the tailnet listener offers the agentsocks tools with the titles, descriptions and schemas local agents see, and nothing that renames the caller", async () => {
  const listed = (await client.listTools()).tools;
  assert.deepEqual(
    listed.map((t) => t.name).sort(),
    ["answer", "ask", "list_channels", "list_peers", "list_tasks", "message_status", "peer_status", "rate_message", "read_inbox", "send_message", "send_task", "subscribe", "unsubscribe", "update_task", "wait_for_message"],
  );
  for (const t of listed) {
    const shared = TOOLS.find((x) => x.name === t.name)!;
    assert.equal(t.title, shared.title, t.name);
    assert.equal(t.description, describeFor(shared, "codex"), t.name);
    assert.deepEqual(Object.keys((t.inputSchema as { properties?: object }).properties ?? {}).sort(), Object.keys(shared.inputSchema).sort(), t.name);
  }
});

test("list_peers shows the sessions on the machine, not the caller itself, with the working directory", async () => {
  const codex = await codexIdentity("codex-thread-m1", "/work/api");
  const r = await call("list_peers");
  assert.match(r.text, /alpha \[[0-9a-f]{6,}\] claude, /);
  assert.match(r.text, new RegExp(`${codex.name} \\[[0-9a-f]{6,}\\] codex`));
  assert.match(r.text, /\/work\/alpha/);
  assert.doesNotMatch(r.text, /hetzner-lab/);
});

test("a message sent through the gateway reaches a Claude session as a cross-session message from the caller's node, with no permission mode and a reply address", async () => {
  const sent = await call("send_message", { to: "alpha", message: "tests are green on hetzner-lab" });
  assert.equal(sent.isError, false);
  assert.match(sent.text, /Sent to @alpha/);
  const frame = await until(() => alpha.frames.find((f) => parseEnvelope(messageContent(f))?.body === "tests are green on hetzner-lab"));
  const env = parseEnvelope(messageContent(frame))!;
  assert.equal(env.fromName, "hetzner-lab");
  assert.equal(env.fromMode, undefined);
  const answer = buildEnvelope({ from: "uds:/claude/alpha", fromName: "alpha", fromSession: alpha.sessionId, body: "good, merge it" });
  await postLines(decodeAddress(env.from!)!, [JSON.stringify({ type: "user", message: { role: "user", content: answer }, priority: "next", from: "uds:/claude/alpha", msg_id: "m-native-1" })]);
  const text = await readUntil("good, merge it");
  assert.match(text, /from="@alpha/);
  assert.doesNotMatch(text, /uds:|\.sock|reply-to/);
  assert.match((await call("read_inbox")).text, /No unread messages\. The latest one, from @alpha/, "a message that was read is gone");
});

test("a local Codex session can message the caller by node name and the caller waits for it", async () => {
  const codex = await codexIdentity("codex-thread-m2", "/work/web");
  const waiting = call("wait_for_message", { timeout_seconds: 10 });
  await new Promise((res) => setTimeout(res, 150));
  await sendMessage(codex, "hetzner-lab", "please review the migration");
  const got = await waiting;
  assert.match(got.text, /please review the migration/);
  assert.match(got.text, /from="@codex-web/);
});

test("wait_for_message with nothing to read returns after the wait, and says so", async () => {
  const started = Date.now();
  const r = await call("wait_for_message", { timeout_seconds: 1 });
  assert.match(r.text, /No message arrived within 1 seconds/);
  assert.ok(Date.now() - started >= 900);
});

test("who the caller is comes from the authenticated node, never from fields the caller writes", async () => {
  const sent = await call("send_message", { to: "alpha", message: "claiming to be someone else" }, { threadId: "codex-thread-m1", sessionId: "alpha-session", name: "alpha", "agentsocks/peer": "alpha" });
  assert.equal(sent.isError, false);
  const frame = await until(() => alpha.frames.find((f) => parseEnvelope(messageContent(f))?.body === "claiming to be someone else"));
  assert.equal(parseEnvelope(messageContent(frame))!.fromName, "hetzner-lab");
});

test("an address is not a recipient over the gateway, only a name or a ref", async () => {
  const r = await call("send_message", { to: `uds:${alpha.socketPath}`, message: "straight to the socket" });
  assert.equal(r.isError, true);
  assert.match(r.text, /send to a name or ref/);
  assert.ok(!alpha.frames.some((f) => parseEnvelope(messageContent(f))?.body === "straight to the socket"));
});

test("a name that no visible peer has is answered with the visible peers, without the working directories", async () => {
  const r = await call("send_message", { to: "nobody-here", message: "hi" });
  assert.equal(r.isError, true);
  assert.match(r.text, /no running session named "nobody-here"/);
  assert.match(r.text, /alpha \[/);
});

test("a tool outside the set is not there, even if the caller names it", async () => {
  const r = await call("set_name", { name: "boss" }).catch((e: Error) => ({ text: e.message, isError: true }));
  assert.equal(r.isError, true);
  assert.match(r.text, /not found|Unknown|unknown/i);
});

test("send_task hands a local Codex session a task and list_tasks shows it to the caller", async () => {
  const codex = await codexIdentity("codex-thread-m3", "/work/tasks");
  const created = await call("send_task", { to: codex.name, title: "run the linter", details: "npm run lint, report failures" });
  assert.equal(created.isError, false);
  assert.match(created.text, /Task T-[0-9a-f]{6} created and sent to @codex-tasks/);
  const listed = await call("list_tasks", { show: "created_by_me" });
  assert.match(listed.text, /run the linter/);
});

test("the caller cannot ask about a peer the gateway would not let it see", async () => {
  const r = await call("peer_status", { peer: "nobody-here" });
  assert.equal(r.isError, true);
});

test("a message is marked read only after the response was written, so a dropped connection loses nothing", async () => {
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { gatewayServer } = await import("../src/gateway/gtools.ts");
  const { ensurePeer } = await import("../src/gateway/remote.ts");
  const peer = await ensurePeer(broker, { id: "token:drop1", name: "dropper", via: "token", mayMessage: ["*"] });
  const codex = await codexIdentity("codex-thread-m9", "/work/drop");
  await sendMessage(codex, "dropper", "do not lose me");
  const commits: (() => void)[] = [];
  const env = { broker, afterResponse: (fn: () => void) => void commits.push(fn), conn: { isClosed: () => false, onClose: () => {} } };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = gatewayServer(env, { peer, via: "token", surface: "public", toolset: "reduced" });
  const local = new Client({ name: "drop-test", version: "0" });
  await Promise.all([server.connect(serverSide), local.connect(clientSide)]);
  try {
    const first = await local.callTool({ name: "read_inbox", arguments: {} });
    assert.match(JSON.stringify(first.content), /do not lose me/);
    const again = await local.callTool({ name: "read_inbox", arguments: {} });
    assert.match(JSON.stringify(again.content), /do not lose me/, "no commit ran, so it is still unread");
    for (const run of commits.splice(0)) run();
    const gone = await local.callTool({ name: "read_inbox", arguments: {} });
    assert.doesNotMatch(JSON.stringify(gone.content), /do not lose me\n|peer-message/);
  } finally {
    await local.close();
    await server.close();
  }
});

test("an address is refused where a peer is named in the other tools too", async () => {
  const status = await call("peer_status", { peer: `uds:${alpha.socketPath}` });
  assert.equal(status.isError, true);
  assert.match(status.text, /Use a name or ref from list_peers/);
  const task = await call("send_task", { to: `uds:${alpha.socketPath}`, title: "x", details: "y" });
  assert.equal(task.isError, true);
  assert.match(task.text, /Use a name or ref from list_peers/);
});
