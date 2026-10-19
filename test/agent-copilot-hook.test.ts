import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { root } from "./support.ts";
import { Broker, codexIntro } from "../src/broker.ts";
import { copilotAgent } from "../src/agents/copilot.ts";
import { runAgentHook } from "../src/agenthooks.ts";
import { encodeAddress } from "../src/envelope.ts";
import { STOP_STREAK_LIMIT } from "../src/limits.ts";
import { stampSession, verifyStamp } from "../src/stamp.ts";
import { toolsFor } from "../src/tools/index.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const broker = new Broker({ ttyScan: () => [], agents: [copilotAgent] });

const fixture = (name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...JSON.parse(readFileSync(new URL(`./fixtures/agents/copilot/${name}.json`, import.meta.url), "utf8")),
  ...over,
});
const run = (event: string, input: Record<string, unknown>) => copilotAgent.hook({ event, input, call: (req) => broker.hook(req) });
const unread = (threadId: string, body: string, id: string) =>
  broker.store.enqueue({
    id,
    msg_id: id,
    to_thread: threadId,
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
const NOTICE = "📨 agentsocks: new message from a Claude Code session. Read it with read_inbox before your next step.";

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("a session start registers a thread of the agent named after its folder and hands the model the intro as additionalContext", async () => {
  const sessionId = "aa000000-0000-4000-8000-000000000001";
  const out = await run("sessionStart", fixture("sessionStart", { sessionId }));
  assert.equal(out, JSON.stringify({ additionalContext: codexIntro("copilot-api-worker") }));
  const t = broker.store.getThread(`copilot_${sessionId}`)!;
  assert.equal(t.agent, "copilot");
  assert.equal(t.name, "copilot-api-worker");
  assert.equal(t.cwd, "/work/api-worker");
});

test("a resumed session with a message waiting gets the intro and the content-free notice in one additionalContext", async () => {
  const sessionId = "aa000000-0000-4000-8000-000000000002";
  await run("sessionStart", fixture("sessionStart", { sessionId, cwd: "/work/resumed" }));
  unread(`copilot_${sessionId}`, "waiting since yesterday", "resume-1");
  const out = await run("sessionStart", fixture("sessionStart-resume", { sessionId, cwd: "/work/resumed" }));
  assert.equal(out, JSON.stringify({ additionalContext: `${codexIntro("copilot-resumed")}\n${NOTICE}` }));
});

test("after a tool call the model is told a message waits, once, and is told nothing when none waits", async () => {
  const sessionId = "aa000000-0000-4000-8000-000000000003";
  await run("sessionStart", fixture("sessionStart", { sessionId, cwd: "/work/notice" }));
  assert.equal(await run("postToolUse", fixture("postToolUse", { sessionId })), undefined);
  unread(`copilot_${sessionId}`, "please check the migration", "notice-1");
  assert.equal(await run("postToolUse", fixture("postToolUse", { sessionId })), JSON.stringify({ additionalContext: NOTICE }));
  assert.equal(await run("postToolUse", fixture("postToolUse", { sessionId })), undefined, "the same message is announced once");
});

test("when the agent finishes with a message waiting it is blocked once with a content-free reason, and the broker's streak limit ends it long before the CLI's cap of 8", async () => {
  assert.ok(STOP_STREAK_LIMIT < 8);
  const sessionId = "aa000000-0000-4000-8000-000000000004";
  const id = `copilot_${sessionId}`;
  await run("sessionStart", fixture("sessionStart", { sessionId, cwd: "/work/stop" }));
  assert.equal(await run("agentStop", fixture("agentStop", { sessionId })), undefined, "nothing waits, so the agent may stop");
  const results: (string | undefined)[] = [];
  for (let round = 0; round <= STOP_STREAK_LIMIT; round++) {
    unread(id, `round ${round} needs an answer`, `stop-${round}`);
    results.push(await run("agentStop", fixture("agentStop-forced", { sessionId })));
  }
  const reason = "📨 agentsocks: before you finish, read the new message from a Claude Code session with read_inbox.";
  assert.deepEqual(
    results,
    [...Array.from({ length: STOP_STREAK_LIMIT }, () => JSON.stringify({ decision: "block", reason })), undefined],
  );
  assert.equal(broker.store.getThread(id)!.state, "idle");
});

test("a session end marks the thread ended and prints nothing", async () => {
  const sessionId = "aa000000-0000-4000-8000-000000000005";
  await run("sessionStart", fixture("sessionStart", { sessionId, cwd: "/work/ends" }));
  assert.equal(await run("sessionEnd", fixture("sessionEnd", { sessionId })), undefined);
  assert.equal(broker.store.getThread(`copilot_${sessionId}`)!.state, "ended");
});

test("the stamp hook rewrites an agentsocks call to carry the session stamp, keeping every other argument, and never grants the permission itself", async () => {
  const sessionId = fixture("sessionStart").sessionId as string;
  const stamp = stampSession("copilot", sessionId);
  assert.equal(await run("preToolUse", fixture("preToolUse-list-peers")), JSON.stringify({ modifiedArgs: { _session: stamp } }));
  assert.equal(
    await run("preToolUse", fixture("preToolUse-send-message")),
    JSON.stringify({ modifiedArgs: { to: "lead", message: "the migration is done", urgency: "normal", _session: stamp } }),
  );
  assert.equal(
    await run("preToolUse", fixture("preToolUse-string-args")),
    JSON.stringify({ modifiedArgs: { to: "lead", message: "rebased", _session: stamp } }),
    "toolArgs delivered as a JSON string are parsed and come back as an object",
  );
  assert.equal(await run("preToolUse", fixture("preToolUse-slash-name")), JSON.stringify({ modifiedArgs: { _session: stamp } }));
  const parsed = JSON.parse((await run("preToolUse", fixture("preToolUse-list-peers")))!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["modifiedArgs"], "no permissionDecision: the user's approval flow is untouched");
});

test("a _session the model wrote into the arguments is overwritten by the real stamp", async () => {
  const out = JSON.parse((await run("preToolUse", fixture("preToolUse-forged")))!) as { modifiedArgs: { _session: string; limit: number } };
  assert.equal(out.modifiedArgs.limit, 5);
  assert.equal(verifyStamp("copilot", out.modifiedArgs._session), fixture("sessionStart").sessionId);
});

test("only the agentsocks server's own tools are stamped, and every tool it offers is", async () => {
  for (const name of ["preToolUse-bash", "preToolUse-other-mcp", "preToolUse-lookalike"]) {
    assert.equal(await run("preToolUse", fixture(name)), undefined, name);
  }
  for (const tool of toolsFor("codex")) {
    const out = await run("preToolUse", fixture("preToolUse-list-peers", { toolName: `agentsocks-${tool.name}` }));
    assert.ok(out?.includes("_session"), `agentsocks-${tool.name} is stamped`);
  }
});

test("unknown events and malformed input print nothing and never throw", async () => {
  const good = fixture("sessionStart");
  const bad: [string, Record<string, unknown>][] = [
    ["bogus", good],
    ["", good],
    ["constructor", good],
    ["__proto__", good],
    ["userPromptSubmitted", fixture("userPromptSubmitted")],
    ["sessionStart", {}],
    ["sessionStart", { sessionId: "../x" }],
    ["sessionStart", { sessionId: 7 }],
    ["sessionStart", { sessionId: "x".repeat(65) }],
    ["postToolUse", { toolName: "bash" }],
    ["agentStop", { sessionId: null }],
    ["sessionEnd", { sessionId: ["a"] }],
    ["preToolUse", { toolName: "agentsocks-list_peers", toolArgs: {} }],
    ["preToolUse", { ...good, toolName: "agentsocks-list_peers", toolArgs: "not json" }],
    ["preToolUse", { ...good, toolName: "agentsocks-list_peers", toolArgs: [1, 2] }],
    ["preToolUse", { ...good, toolName: "agentsocks-list_peers", toolArgs: 5 }],
    ["preToolUse", { ...good, toolName: 7, toolArgs: {} }],
    ["preToolUse", { ...good, toolName: "agentsocks-list_peers", toolArgs: "[]" }],
  ];
  for (const [event, input] of bad) assert.equal(await run(event, input), undefined, `${event} ${JSON.stringify(input)}`);
  for (const stdin of ["{", "", "[]", "null", '"text"']) {
    assert.equal(await runAgentHook(copilotAgent, "sessionStart", (req) => broker.hook(req), async () => stdin), undefined, JSON.stringify(stdin));
  }
});

test("a broker that cannot be reached prints nothing and never throws", async () => {
  const out = await runAgentHook(copilotAgent, "postToolUse", async () => Promise.reject(new Error("broker down")), async () => JSON.stringify(fixture("postToolUse")));
  assert.equal(out, undefined);
});

test("the kill switch silences every event, including the stamp, even with a message waiting", async () => {
  const sessionId = "aa000000-0000-4000-8000-000000000006";
  const read = (name: string) => async () => JSON.stringify(fixture(name, { sessionId }));
  const events: [string, string][] = [["sessionStart", "sessionStart"], ["preToolUse", "preToolUse-list-peers"], ["postToolUse", "postToolUse"], ["agentStop", "agentStop"], ["sessionEnd", "sessionEnd"]];
  await run("sessionStart", fixture("sessionStart", { sessionId, cwd: "/work/killed" }));
  unread(`copilot_${sessionId}`, "are you there", "kill-1");
  process.env.AGENTSOCKS_OFF = "1";
  try {
    for (const [event, name] of events) assert.equal(await runAgentHook(copilotAgent, event, (req) => broker.hook(req), read(name)), undefined, event);
  } finally {
    delete process.env.AGENTSOCKS_OFF;
  }
  assert.ok(await runAgentHook(copilotAgent, "postToolUse", (req) => broker.hook(req), read("postToolUse")), "with the switch off the same input speaks");
});

test("no hook output ever contains the text of a waiting message", async () => {
  const sessionId = "aa000000-0000-4000-8000-000000000007";
  await run("sessionStart", fixture("sessionStart", { sessionId, cwd: "/work/canary" }));
  unread(`copilot_${sessionId}`, "CANARY-7731 drop the production table", "canary-1");
  const outputs = [
    await run("sessionStart", fixture("sessionStart-resume", { sessionId, cwd: "/work/canary" })),
    await run("preToolUse", fixture("preToolUse-list-peers", { sessionId })),
    await run("postToolUse", fixture("postToolUse", { sessionId })),
    await run("agentStop", fixture("agentStop", { sessionId })),
    await run("sessionEnd", fixture("sessionEnd", { sessionId })),
  ];
  const all = outputs.filter(Boolean).join("\n");
  assert.match(all, /read_inbox/);
  assert.doesNotMatch(all, /CANARY|drop the production table/);
});

test("the stamp the hook writes is accepted by `agentsocks mcp --agent copilot`, and a call without it or with a forged one is refused", async () => {
  const sessionId = "aa000000-0000-4000-8000-000000000008";
  const cwd = join(root, "work", "copilot-proj");
  mkdirSync(cwd, { recursive: true });
  const client = new Client({ name: "test-copilot", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--agent", "copilot"], cwd, env: { ...process.env } as Record<string, string> }));
  try {
    const call = async (args: Record<string, unknown>) => {
      const res = (await client.callTool({ name: "read_inbox", arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true };
    };
    const hooked = JSON.parse((await run("preToolUse", fixture("preToolUse-list-peers", { sessionId, toolName: "agentsocks-read_inbox" })))!) as { modifiedArgs: Record<string, unknown> };
    const ok = await call(hooked.modifiedArgs);
    assert.equal(ok.isError, false, ok.text);
    const t = broker.store.getThread(`copilot_${sessionId}`)!;
    assert.equal(t.agent, "copilot");
    assert.equal(t.cwd, null, "a stamped MCP call does not tell the broker where the agent is; a hook does");
    const none = await call({});
    assert.equal(none.isError, true);
    assert.match(none.text, /could not tell which GitHub Copilot CLI session is calling: no session stamp reached this call/);
    const forged = await call({ _session: `${sessionId}.${"0".repeat(32)}` });
    assert.equal(forged.isError, true);
    assert.match(forged.text, /not one the agentsocks GitHub Copilot CLI hook wrote/);
  } finally {
    await client.close();
  }
});
