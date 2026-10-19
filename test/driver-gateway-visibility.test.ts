import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Broker } from "../src/broker.ts";
import { fakeLocalApi, fakeServe, mcpClient, type FakeLocalApi, type FakeServe } from "./gatewaysupport.ts";

const broker = new Broker();
let api: FakeLocalApi;
let serve: FakeServe;
let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n"), isError: r.isError === true };
};

before(async () => {
  api = await fakeLocalApi();
  process.env.TS_SOCKET = api.socketPath;
  api.machines.set("100.64.9.9", { name: "hetzner-lab", login: "sam@example.com", ip: "100.64.9.9" });
  await broker.start();
  await broker.hook({ threadId: "w4cg-worker", event: "SessionStart", cwd: "/work/w4cwg" });
  await broker.hook({ threadId: "w4cg-boss", event: "SessionStart", cwd: "/work/w4cwb" });
  const on = (await broker.dispatch({ op: "gateway_on", port: 0 })).result as { private: { port: number } };
  serve = await fakeServe(on.private.port, { login: "sam@example.com", ip: "100.64.9.9" });
  client = await mcpClient(serve.url);
});

after(async () => {
  await client.close();
  await serve.close();
  await broker.stop();
  await api.close();
});

test("gateway peer_status hides a driver the caller may not see", async () => {
  const worker = broker.store.getThread("w4cg-worker")!.name;
  const boss = broker.store.getThread("w4cg-boss")!.name;
  await broker.dispatch({ op: "set_driver", threadId: "w4cg-worker", addr: `uds:${broker.describe(broker.store.getThread("w4cg-boss")!).socketPath}`, name: boss });
  await broker.dispatch({ op: "gateway_may", peer: "hetzner-lab", mayMessage: [worker] });
  const shown = await call("peer_status", { peer: worker });
  assert.equal(shown.isError, false, shown.text);
  assert.doesNotMatch(shown.text, /driver: @/, "the driver is outside the caller's list, so no driver line");
  await broker.dispatch({ op: "gateway_may", peer: "hetzner-lab", mayMessage: [worker, boss] });
  const open = await call("peer_status", { peer: worker });
  assert.match(open.text, new RegExp(`driver: @${boss}`), "visible driver is shown");
});

test("send_task refusal, ask result and channel post hide a driver outside the caller's list", async () => {
  const worker = broker.store.getThread("w4cg-worker")!.name;
  const boss = broker.store.getThread("w4cg-boss")!.name;
  await broker.dispatch({ op: "gateway_may", peer: "hetzner-lab", mayMessage: [worker] });
  const task = await call("send_task", { to: worker, title: "do a thing", details: "details" });
  assert.equal(task.isError, true);
  assert.match(task.text, /may not act on it/);
  assert.doesNotMatch(task.text, new RegExp(`works for ${boss}`), "the refusal names no driver");
  const ask = await call("ask", { to: [worker], question: "status?", timeout_seconds: 1 });
  assert.doesNotMatch(ask.text, new RegExp(`works for ${boss}`), "the ask note names no driver");
  const wt = broker.store.getThread("w4cg-worker")!;
  broker.channels.subscribe(
    { kind: "codex", name: worker, addr: `uds:${broker.describe(wt).socketPath}`, session: "w4cg-worker", mode: null },
    "w4c-leakchan",
  );
  const post = await call("send_message", { to: "#w4c-leakchan", message: "hello channel" });
  assert.equal(post.isError, false, post.text);
  assert.doesNotMatch(post.text, new RegExp(`works for ${boss}`), "the post note names no driver");
});
