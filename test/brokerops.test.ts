import { test, after } from "node:test";
import assert from "node:assert/strict";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { OPS, registry } from "../src/brokerops/index.ts";
import type { OpHandler } from "../src/brokerops/types.ts";

const broker = new Broker();
after(async () => {
  await broker.stop();
});

const SENT_BY_CLIENTS = ["ping", "register", "hook", "take", "wait", "set_name", "set_driver", "route_send", "task_create", "task_update", "task_list", "task_get", "message_status", "peer_status", "stats", "list_threads", "channel_subscribe", "channel_unsubscribe", "channel_list", "channel_send", "ask_create", "ask_wait", "ask_answer", "ask_pick", "label_rate", "label_export"];

test("every op that a client, hook or older release sends is registered", () => {
  for (const op of SENT_BY_CLIENTS) assert.ok(OPS.has(op), `${op} is registered`);
});

test("an op registered twice is refused when the registry is assembled", () => {
  const handler: OpHandler = async () => ({ result: null });
  assert.throws(() => registry({ digest: handler }, { digest: handler }), /broker op digest is registered twice/);
});

test("an op the broker does not know is answered with 'unknown op', whatever the name or type", async () => {
  await broker.start();
  for (const op of ["nope", "constructor", "__proto__", "toString", "", 5, null, undefined]) {
    await assert.rejects(broker.dispatch({ op }), { message: `unknown op ${String(op)}` }, `op ${String(op)}`);
  }
  await assert.rejects(broker.dispatch({}), { message: "unknown op undefined" });
});

test("ops that need a thread refuse a missing or malformed threadId before they record anything", async () => {
  const threads = broker.store.listThreads(true).length;
  for (const op of ["register", "hook", "take", "wait", "set_name", "set_driver"]) {
    for (const threadId of [undefined, "", "has space", "x".repeat(81), 7]) {
      await assert.rejects(broker.dispatch({ op, threadId }), { message: "threadId required" }, `${op} ${String(threadId)}`);
    }
  }
  assert.equal(broker.store.listThreads(true).length, threads);
});

test("register records the cwd, permission mode and remote it is given, and ignores fields of the wrong type", async () => {
  await broker.dispatch({ op: "register", threadId: "thread-fields", cwd: "/work/fields", permissionMode: "bypassPermissions", remote: "ws://127.0.0.1:9" });
  const row = broker.store.getThread("thread-fields")!;
  assert.deepEqual([row.cwd, row.mode, row.remote], ["/work/fields", "bypass", "ws://127.0.0.1:9"]);
  await broker.dispatch({ op: "register", threadId: "thread-wrong-types", cwd: 5, permissionMode: {}, remote: null });
  const wrong = broker.store.getThread("thread-wrong-types")!;
  assert.deepEqual([wrong.cwd, wrong.mode, wrong.remote], [null, null, null]);
});

test("hook hands the whole request to the hook handler under the validated thread id", async () => {
  await broker.dispatch({ op: "hook", threadId: "thread-hook", event: "PostToolUse", toolName: "Edit", cwd: "/work/hook" });
  const row = broker.store.getThread("thread-hook")!;
  assert.deepEqual([row.last_tool, row.cwd, row.state], ["Edit", "/work/hook", "busy"]);
});
