import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { root } from "./support.ts";
import { Broker, type HookRequest, type HookResult } from "../src/broker.ts";
import { runAgentHook } from "../src/agenthooks.ts";
import { encodeAddress } from "../src/envelope.ts";
import { stampSession, verifyStamp } from "../src/stamp.ts";
import { cursorAgent } from "../src/agents/cursor.ts";
import { CURSOR_HOOKS, TOOL_NAMES } from "../src/agents/cursor/hooks.ts";
import { STOP_STREAK_LIMIT } from "../src/limits.ts";
import { toolsFor } from "../src/tools/index.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
type Input = Record<string, unknown>;
const FIXTURES = { sessionStart: "session-start", preToolUse: "pre-tool-use-mcp", postToolUse: "post-tool-use-shell", stop: "stop-completed", sessionEnd: "session-end" } as const;
const fixture = (event: keyof typeof FIXTURES, conversation?: string): Input => {
  const input = JSON.parse(readFileSync(new URL(`./fixtures/agents/cursor/${FIXTURES[event]}.json`, import.meta.url), "utf8")) as Input;
  if (!conversation) return input;
  return { ...input, conversation_id: conversation, ...("session_id" in input && { session_id: conversation }) };
};
const CONVERSATION = fixture("sessionStart").conversation_id as string;
const threadOf = (conversation: string) => `cursor_${conversation}`;

const broker = new Broker({ agents: [cursorAgent], wakeEnabled: false, ttyScan: () => [] });
const run = (event: string, input: Input) => cursorAgent.hook({ event, input, call: (req) => broker.hook(req) });
const stub = (result: HookResult, seen: HookRequest[] = []) => async (req: HookRequest): Promise<HookResult> => {
  seen.push(req);
  return result;
};
const unread = (id: string, body: string, conversation: string) =>
  broker.store.enqueue({
    id,
    msg_id: id,
    to_thread: threadOf(conversation),
    kind: "message",
    from_addr: encodeAddress(`${root}/cc-socks/ann.sock`),
    from_name: "ann",
    from_kind: "claude",
    from_session: null,
    from_mode: null,
    body,
    received_at: Date.now(),
    route: "now",
    decision: null,
  });

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("sessionStart registers the conversation as a Cursor thread named after its workspace root and answers with the agentsocks intro as additional_context", async () => {
  const out = await run("sessionStart", fixture("sessionStart"));
  const t = broker.store.getThread(threadOf(CONVERSATION))!;
  assert.equal(t.agent, "cursor");
  assert.equal(t.name, "cursor-payments-api");
  assert.equal(t.cwd, "/work/payments-api");
  const parsed = JSON.parse(out!);
  assert.deepEqual(Object.keys(parsed), ["additional_context"]);
  assert.match(parsed.additional_context, /^\[agentsocks\] .*@cursor-payments-api/s);
});

test("each event prints exactly the JSON Cursor documents for it, and nothing when the broker has nothing to say", async () => {
  const seen: HookRequest[] = [];
  assert.equal(await cursorAgent.hook({ event: "sessionStart", input: fixture("sessionStart"), call: stub({ context: "CTX" }, seen) }), '{"additional_context":"CTX"}');
  assert.equal(await cursorAgent.hook({ event: "postToolUse", input: fixture("postToolUse"), call: stub({ context: "CTX" }, seen) }), '{"additional_context":"CTX"}');
  assert.equal(await cursorAgent.hook({ event: "stop", input: fixture("stop"), call: stub({ block: "BLOCK" }, seen) }), '{"followup_message":"BLOCK"}');
  assert.equal(await cursorAgent.hook({ event: "sessionEnd", input: fixture("sessionEnd"), call: stub({ context: "IGNORED", block: "IGNORED" }, seen) }), undefined);
  for (const event of ["sessionStart", "postToolUse", "stop"] as const) assert.equal(await cursorAgent.hook({ event, input: fixture(event), call: stub({}) }), undefined, event);
  assert.deepEqual(
    seen.map((r) => [r.event, r.threadId, r.agent, r.cwd, r.toolName]),
    [
      ["SessionStart", threadOf(CONVERSATION), "cursor", "/work/payments-api", undefined],
      ["PostToolUse", threadOf(CONVERSATION), "cursor", "/work/payments-api", "Shell"],
      ["Stop", threadOf(CONVERSATION), "cursor", "/work/payments-api", undefined],
      ["SessionEnd", threadOf(CONVERSATION), "cursor", "/work/payments-api", undefined],
    ],
    "the thread follows the workspace root, even when a tool ran in a subfolder",
  );
});

test("a message that waits is announced after the next tool call with the content-free notice, once, and its text never rides in a hook", async () => {
  const c = "notice";
  await run("sessionStart", fixture("sessionStart", c));
  assert.equal(await run("postToolUse", fixture("postToolUse", c)), undefined, "nothing waits, nothing is said");
  unread("n1", "SECRET-BODY the schema changed, drop the table", c);
  const notice = await run("postToolUse", fixture("postToolUse", c));
  assert.equal(notice, JSON.stringify({ additional_context: "📨 agentsocks: new message from a Claude Code session. Read it with read_inbox before your next step." }));
  assert.equal(await run("postToolUse", fixture("postToolUse", c)), undefined, "told once");
  const stop = await run("stop", fixture("stop", c));
  assert.match(stop!, /^\{"followup_message":"📨 agentsocks: before you finish, read the new message from a Claude Code session with read_inbox\."\}$/, "still unread at the end of the turn");
  assert.doesNotMatch(`${notice}${stop}`, /SECRET-BODY|schema|drop the table/);
});

test("stop asks for one more turn with followup_message while messages wait, and the broker's streak limit ends it before Cursor's own loop limit", async () => {
  const c = "streak";
  await run("sessionStart", fixture("sessionStart", c));
  const outputs: (string | undefined)[] = [];
  for (let i = 0; i < 4; i++) {
    unread(`s${i}`, `message ${i}`, c);
    outputs.push(await run("stop", { ...fixture("stop", c), loop_count: i }));
  }
  assert.deepEqual(
    outputs.map((o) => o !== undefined),
    [true, true, true, false],
    "three nudges, then the broker lets the turn end",
  );
  for (const o of outputs.slice(0, 3)) {
    assert.deepEqual(Object.keys(JSON.parse(o!)), ["followup_message"]);
    assert.match(JSON.parse(o!).followup_message, /^📨 agentsocks: before you finish, read the new message from a Claude Code session with read_inbox\.$/);
  }
  assert.ok(CURSOR_HOOKS.stop.loop_limit! > STOP_STREAK_LIMIT, "Cursor's explicit limit sits above the broker's");
});

test("stop asks for no follow-up when the turn was aborted or errored or Cursor's loop limit is spent, and the waiting message is not used up", async () => {
  const c = "loopguard";
  await run("sessionStart", fixture("sessionStart", c));
  unread("g1", "wait for me", c);
  for (const extra of [{ status: "aborted" }, { status: "error" }, { loop_count: CURSOR_HOOKS.stop.loop_limit }, { loop_count: 99 }]) {
    assert.equal(await run("stop", { ...fixture("stop", c), ...extra }), undefined, JSON.stringify(extra));
  }
  assert.match((await run("stop", fixture("stop", c)))!, /followup_message/, "the message still waited for a turn that can continue");
});

test("a stop with nothing waiting marks the conversation idle and prints nothing", async () => {
  const c = "quiet";
  await run("sessionStart", fixture("sessionStart", c));
  await run("postToolUse", fixture("postToolUse", c));
  assert.equal(broker.store.getThread(threadOf(c))!.state, "busy");
  assert.equal(await run("stop", fixture("stop", c)), undefined);
  assert.equal(broker.store.getThread(threadOf(c))!.state, "idle");
});

test("sessionEnd tells the broker the conversation is over and prints nothing", async () => {
  const c = "ending";
  await run("sessionStart", fixture("sessionStart", c));
  assert.equal(await run("sessionEnd", fixture("sessionEnd", c)), undefined);
  assert.equal(broker.store.getThread(threadOf(c))!.state, "ended");
});

test("sessionStart may carry the conversation only as session_id", async () => {
  const input = fixture("sessionStart", "only-session-id");
  delete input.conversation_id;
  await run("sessionStart", input);
  assert.equal(broker.store.getThread(threadOf("only-session-id"))!.agent, "cursor");
});

test("preToolUse for an agentsocks MCP tool leaves the approval to Cursor and rewrites its input with the session stamp, keeping every other field and overriding a stamp the model wrote", async () => {
  const stamp = stampSession("cursor", CONVERSATION);
  const out = await run("preToolUse", fixture("preToolUse"));
  assert.equal(out, JSON.stringify({ permission: "ask", updated_input: { to: "ann", message: "the migration is done", _session: stamp } }));
  assert.equal(verifyStamp("cursor", JSON.parse(out!).updated_input._session), CONVERSATION);

  const written = await run("preToolUse", { ...fixture("preToolUse"), tool_input: { to: "ann", message: "hi", _session: "someone-else.00000000000000000000000000000000" } });
  assert.equal(JSON.parse(written!).updated_input._session, stamp);
  assert.deepEqual(Object.keys(JSON.parse(written!).updated_input), ["to", "message", "_session"]);
});

test("preToolUse takes the tool name with or without the MCP: prefix and the input as an object or a JSON string, and a no-argument tool gets just the stamp", async () => {
  const stamp = stampSession("cursor", CONVERSATION);
  const bare = await run("preToolUse", { ...fixture("preToolUse"), tool_name: "send_message" });
  assert.equal(JSON.parse(bare!).updated_input._session, stamp);
  const asString = await run("preToolUse", { ...fixture("preToolUse"), tool_input: JSON.stringify({ to: "ann", message: "hi" }) });
  assert.deepEqual(JSON.parse(asString!).updated_input, { to: "ann", message: "hi", _session: stamp });
  for (const tool_input of [{}, undefined, null, "", "  "]) {
    const none = await run("preToolUse", { ...fixture("preToolUse"), tool_name: "MCP:list_peers", tool_input });
    assert.deepEqual(JSON.parse(none!).updated_input, { _session: stamp }, `no arguments as ${JSON.stringify(tool_input)}`);
  }
});

test("preToolUse leaves every tool that is not agentsocks's alone, including a same-named tool when Cursor names another server, and never replaces an input it cannot read", async () => {
  const base = fixture("preToolUse");
  const untouched: Input[] = [
    { ...base, tool_name: "Shell", tool_input: { command: "ls" } },
    { ...base, tool_name: "MCP:linear_create_issue" },
    { ...base, tool_name: "MCP:send_message_to_slack" },
    { ...base, mcp_server_name: "slack" },
    { ...base, tool_input: "not json" },
    { ...base, tool_input: "[1,2]" },
    { ...base, tool_input: 7 },
    { ...base, conversation_id: "../etc" },
    { ...base, conversation_id: undefined },
  ];
  for (const input of untouched) assert.equal(await run("preToolUse", input), undefined, JSON.stringify(input));
  assert.ok(await run("preToolUse", { ...base, mcp_server_name: "agentsocks" }), "a server name that is ours is fine when Cursor sends one");
});

test("unknown events, an empty event and input that is not what Cursor documents produce no output, no broker call and no throw", async () => {
  const seen: HookRequest[] = [];
  const call = stub({ context: "CTX", block: "BLOCK" }, seen);
  for (const event of ["beforeSubmitPrompt", "afterAgentResponse", "subagentStop", "SessionStart", "", "nonsense", "constructor", "toString", "__proto__"]) {
    assert.equal(await cursorAgent.hook({ event, input: fixture("sessionStart"), call }), undefined, event);
  }
  for (const input of [{}, { conversation_id: 7 }, { conversation_id: "a b" }, { conversation_id: "x".repeat(80) }, { session_id: ["x"] }]) {
    for (const event of ["sessionStart", "postToolUse", "stop", "sessionEnd", "preToolUse"]) {
      assert.equal(await cursorAgent.hook({ event, input, call }), undefined, `${event} ${JSON.stringify(input)}`);
    }
  }
  assert.deepEqual(seen, []);
});

test("the kill switch silences every event before the adapter or the broker is reached", async () => {
  let calls = 0;
  const call = async (): Promise<HookResult> => {
    calls++;
    return { context: "CTX", block: "BLOCK" };
  };
  process.env.AGENTSOCKS_OFF = "1";
  try {
    for (const event of Object.keys(FIXTURES) as (keyof typeof FIXTURES)[]) {
      assert.equal(await runAgentHook(cursorAgent, event, call, async () => JSON.stringify(fixture(event))), undefined, event);
    }
  } finally {
    delete process.env.AGENTSOCKS_OFF;
  }
  assert.equal(calls, 0);
  assert.equal(await runAgentHook(cursorAgent, "stop", call, async () => JSON.stringify(fixture("stop"))), '{"followup_message":"BLOCK"}', "it was the switch that silenced them");
});

test("the preToolUse matcher selects exactly the agentsocks tools, and every tool the Cursor MCP server offers is matched and stamped", async () => {
  const matcher = new RegExp(CURSOR_HOOKS.preToolUse.matcher!);
  const offered = toolsFor("codex").map((t) => t.name);
  assert.ok(offered.length >= 17, "the combined tool set is not truncated");
  for (const name of ["ask", "answer", "subscribe", "unsubscribe", "list_channels", "broadcast", "rate_message", "send_message", "read_inbox"]) assert.ok(offered.includes(name), `${name} is offered`);
  assert.deepEqual([...TOOL_NAMES], offered, "the stamped set is the registry's, not a copy of it");
  for (const name of offered) {
    assert.ok(matcher.test(`MCP:${name}`), `${name} matches the hook matcher`);
    for (const tool_name of [`MCP:${name}`, name]) {
      const out = await run("preToolUse", { ...fixture("preToolUse"), tool_name, tool_input: {} });
      assert.ok(out, `${tool_name} is stamped`);
      assert.equal(verifyStamp("cursor", JSON.parse(out).updated_input._session), CONVERSATION, tool_name);
    }
  }
  for (const other of ["Shell", "Read", "MCP:send_messages", "MCP:xsend_message", "MCP:linear_send_message", "MCP:", "send_message", "MCP:send_message_to_slack", "MCP:asks", "MCP:xask"]) assert.ok(!matcher.test(other), other);
  assert.equal(await run("preToolUse", { ...fixture("preToolUse"), tool_name: "MCP:asks", tool_input: {} }), undefined, "a tool whose name merely starts like ours is left alone");
});

test("the stamp the hook writes is the one a Cursor MCP server accepts: the call registers as that conversation's thread, and a call without it is refused", async () => {
  const c = "mcp-e2e";
  const stamp = JSON.parse((await run("preToolUse", { ...fixture("preToolUse", c), tool_name: "MCP:read_inbox", tool_input: {} }))!).updated_input._session as string;
  const client = new Client({ name: "cursor-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--agent", "cursor"], cwd: root, env: { ...process.env } as Record<string, string> }));
  try {
    await run("sessionStart", fixture("sessionStart", c));
    unread("e1", "rebase onto main", c);
    const read = (await client.callTool({ name: "read_inbox", arguments: { _session: stamp } })) as { content: { text: string }[]; isError?: boolean };
    assert.equal(read.isError ?? false, false);
    assert.match(read.content[0]!.text, /rebase onto main/);
    const refused = (await client.callTool({ name: "read_inbox", arguments: {} })) as { content: { text: string }[]; isError?: boolean };
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]!.text, /could not tell which Cursor session is calling/);
  } finally {
    await client.close();
  }
});

function cliHook(event: string, stdin: string, env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "hook", "cursor", event], { env: { ...process.env, NODE_NO_WARNINGS: "1", ...env }, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code }));
    child.stdin.end(stdin);
  });
}

test("agentsocks hook cursor <event> reads Cursor's JSON on stdin and prints one JSON line or nothing, and always exits 0", async () => {
  const c = "cli-run";
  const input = JSON.stringify(fixture("postToolUse", c));
  await run("sessionStart", fixture("sessionStart", c));
  assert.deepEqual(await cliHook("postToolUse", input), { stdout: "", code: 0 });
  unread("c1", "from the cli path", c);
  const noticed = await cliHook("postToolUse", input);
  assert.equal(noticed.code, 0);
  assert.equal(noticed.stdout, `${JSON.stringify({ additional_context: "📨 agentsocks: new message from a Claude Code session. Read it with read_inbox before your next step." })}\n`);
  assert.deepEqual(await cliHook("postToolUse", "{not json"), { stdout: "", code: 0 });
  assert.deepEqual(await cliHook("postToolUse", ""), { stdout: "", code: 0 });
  assert.deepEqual(await cliHook("stop", JSON.stringify(fixture("stop", c)), { AGENTSOCKS_OFF: "1" }), { stdout: "", code: 0 });
});
