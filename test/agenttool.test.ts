import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Broker } from "../src/broker.ts";
import { runAgentTool } from "../src/agenttool.ts";
import { encodeAddress } from "../src/envelope.ts";
import { root } from "./support.ts";

const broker = new Broker({ wakeEnabled: false });

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("a plugin tool call runs the same tool an MCP call would, as the session it names, and registers that session under its agent", async () => {
  const empty = await runAgentTool("opencode", "read_inbox", "ses_abc", "/work/api", {});
  assert.deepEqual(empty, { text: "No new messages.", isError: false });
  const t = broker.store.getThread("opencode_ses_abc")!;
  assert.equal(t.agent, "opencode");
  assert.equal(t.cwd, "/work/api");
  broker.store.enqueue({ id: "t1", msg_id: "t1", to_thread: "opencode_ses_abc", kind: "message", from_addr: encodeAddress(`${root}/cc-socks/ann.sock`), from_name: "ann", from_kind: "claude", from_session: null, from_mode: null, body: "the schema changed", received_at: Date.now(), route: "now", decision: null });
  const read = await runAgentTool("opencode", "read_inbox", "ses_abc", "/work/api", {});
  assert.match(read.text, /the schema changed/);
  assert.equal(read.isError, false);
});

test("a plugin tool call with arguments that do not fit the tool, an unknown tool, or a session id that is not one fails with a message instead of reaching the broker", async () => {
  const missing = await runAgentTool("opencode", "send_message", "ses_abc", undefined, { message: "hi" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /send_message: to /);
  assert.deepEqual(await runAgentTool("opencode", "format_disk", "ses_abc", undefined, {}), { text: "agentsocks has no tool format_disk", isError: true });
  const bad = await runAgentTool("opencode", "read_inbox", "../x", undefined, {});
  assert.equal(bad.isError, true);
  assert.match(bad.text, /not a session id/);
  assert.equal(broker.store.getThread("opencode_../x"), undefined);
});

test("agentsocks tool prints one JSON line with the text and whether it failed, and exits 1 on a failure", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const run = (args: string[], input: string) => spawnSync(process.execPath, [cli, "tool", ...args], { input, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  const bad = run(["opencode", "send_message", "--session", "ses_abc"], "{}");
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).isError, true);
  assert.match(JSON.parse(bad.stdout).text, /send_message: to /);
  const notJson = run(["opencode", "read_inbox", "--session", "ses_abc"], "{nope");
  assert.equal(notJson.status, 1);
  assert.deepEqual(JSON.parse(notJson.stdout), { text: "the arguments are not valid JSON", isError: true });
  const usage = run(["opencode", "read_inbox"], "{}");
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: agentsocks tool/);
});
