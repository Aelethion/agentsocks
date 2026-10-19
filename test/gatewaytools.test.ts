import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { TOOL_SURFACES, toolNamesFor } from "../src/gateway/gtools.ts";
import { TOOLS } from "../src/tools/index.ts";
import { fakeLocalApi, fakeServe, mcpClient, type FakeLocalApi, type FakeServe } from "./gatewaysupport.ts";

const FULL = [
  "answer",
  "ask",
  "list_channels",
  "list_peers",
  "list_tasks",
  "message_status",
  "peer_status",
  "rate_message",
  "read_inbox",
  "send_message",
  "send_task",
  "subscribe",
  "unsubscribe",
  "update_task",
  "wait_for_message",
];
const REDUCED = ["answer", "list_peers", "read_inbox", "send_message", "wait_for_message"];

const broker = new Broker();
let api: FakeLocalApi;
let serve: FakeServe;
let tailnet: Client;
let alpha: FakeClaude;
let base = "";

before(async () => {
  api = await fakeLocalApi();
  process.env.TS_SOCKET = api.socketPath;
  api.machines.set("100.64.1.1", { name: "hetzner-lab", login: "sam@example.com", ip: "100.64.1.1" });
  await broker.start();
  alpha = await fakeClaude("alpha", livePid(), "idle");
  const on = (await broker.dispatch({ op: "gateway_on", port: 0 })).result as { private: { port: number } };
  serve = await fakeServe(on.private.port, { login: "sam@example.com", ip: "100.64.1.1" });
  tailnet = await mcpClient(serve.url);
  const pub = (await broker.dispatch({ op: "gateway_public", via: "funnel", port: 0 })).result as { public: { port: number } };
  base = `http://127.0.0.1:${pub.public.port}`;
});

after(async () => {
  await tailnet.close();
  await serve.close();
  await closeServer(alpha.server);
  await broker.stop();
  await api.close();
});

test("every tool in the shared list has a deliberate decision for the gateway, and the table names no tool that does not exist, so a new tool is not offered or hidden by accident", () => {
  assert.deepEqual(Object.keys(TOOL_SURFACES).sort(), TOOLS.map((t) => t.name).sort());
  for (const [name, sets] of Object.entries(TOOL_SURFACES)) for (const set of sets) assert.ok(set === "full" || set === "reduced", `${name}: ${set}`);
});

test("the tailnet set is the nine tools of the gateway and the channel, ask and rating tools, without broadcast and without set_name", () => {
  assert.deepEqual([...toolNamesFor("full")].sort(), FULL);
  assert.ok(!toolNamesFor("full").includes("broadcast"));
  assert.ok(!toolNamesFor("full").includes("set_name"));
  assert.ok(!toolNamesFor("full").includes("set_driver"));
});

test("the public set is the four message tools and answer, and none of the channel, ask or rating tools", () => {
  assert.deepEqual([...toolNamesFor("reduced")].sort(), REDUCED);
});

test("the tailnet listener lists exactly the tailnet set", async () => {
  assert.deepEqual((await tailnet.listTools()).tools.map((t) => t.name).sort(), FULL);
});

test("the public listener lists exactly the public set to a token peer", async () => {
  const made = (await broker.dispatch({ op: "gateway_token_add", name: "toolset-grok", mayMessage: ["alpha"] })).result as { token: string };
  const client = await mcpClient(base, { Authorization: `Bearer ${made.token}` });
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), REDUCED);
    for (const name of ["subscribe", "unsubscribe", "list_channels", "broadcast", "ask", "rate_message"]) {
      const r = await client.callTool({ name, arguments: { channel: "x", message: "m", to: ["alpha"], question: "q", rating: "noise" } }).catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }));
      assert.equal(r.isError, true, name);
      assert.match(JSON.stringify(r.content), /not found|unknown|Unknown/i, name);
    }
  } finally {
    await client.close();
  }
});

test("broadcast cannot be called over the tailnet listener", async () => {
  const r = await tailnet.callTool({ name: "broadcast", arguments: { message: "to everyone" } }).catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }));
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(r.content), /not found|unknown|Unknown/i);
  assert.equal(alpha.frames.length, 0);
});
