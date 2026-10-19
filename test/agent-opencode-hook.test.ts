import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Broker, type HookRequest, type HookResult } from "../src/broker.ts";
import { runAgentHook } from "../src/agenthooks.ts";
import { opencodeAgent } from "../src/agents/opencode.ts";
import { encodeAddress } from "../src/envelope.ts";
import { STOP_STREAK_LIMIT } from "../src/limits.ts";
import { GITHUB_PAT } from "./fakes.ts";
import { root, sleep } from "./support.ts";
import { tempDir } from "./tmp.ts";

const inputs = JSON.parse(readFileSync(new URL("./fixtures/agents/opencode/hook-inputs.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;
const SECRET_BODY = "rotate the prod key sk-live-NOT-FOR-THE-MODEL and run rm -rf /tmp/x";
const NEW_MESSAGE = "📨 agentsocks: new message from a Claude Code session. Read it with agentsocks_read_inbox before your next step.";

const broker = new Broker({ ttyScan: () => [], agents: [opencodeAgent], wakeEnabled: false });
const via = (req: HookRequest): Promise<HookResult> => broker.hook(req);
const run = (event: string, input: Record<string, unknown> = inputs[event] ?? {}, call = via) => opencodeAgent.hook({ event, input, call });
const thread = (raw: string) => broker.store.getThread(`opencode_${raw}`)!;
const unread = (raw: string, id: string, body = SECRET_BODY) =>
  broker.store.enqueue({ id, msg_id: id, to_thread: `opencode_${raw}`, kind: "message", from_addr: encodeAddress(`${root}/cc-socks/ann.sock`), from_name: "ann", from_kind: "claude", from_session: null, from_mode: null, body, received_at: Date.now(), route: "now", decision: null });
const fresh = (raw: string) => ({ ...inputs.SessionStart!, session: raw });

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("a session start registers the session as an OpenCode thread with its folder, state idle and the plugin's sink, and prints nothing when nothing waits", async () => {
  assert.equal(await run("SessionStart"), undefined);
  const t = thread("ses_2f3a9c4d1e");
  assert.equal(t.agent, "opencode");
  assert.equal(t.cwd, "/work/api");
  assert.equal(t.name, "opencode-api");
  assert.equal(t.state, "idle");
  assert.equal(t.remote, "0123456789abcdef01234567");
  assert.equal(t.hooks_active, 1);
});

test("a session start with messages already waiting prints the content-free notice and nothing else, not the broker's introduction", async () => {
  await run("SessionStart", fresh("ses_waiting1"));
  unread("ses_waiting1", "w-1");
  const out = await run("SessionStart", fresh("ses_waiting1"));
  assert.equal(out, JSON.stringify({ context: NEW_MESSAGE }));
  assert.doesNotMatch(out ?? "", /sk-live|rm -rf|reachable as/);
});

test("a tool call with a message waiting prints the notice as JSON, byte for byte, once; the next call prints nothing", async () => {
  await run("SessionStart", fresh("ses_tool0001"));
  assert.equal(await run("PostToolUse", { ...inputs.PostToolUse!, session: "ses_tool0001" }), undefined);
  unread("ses_tool0001", "t-1");
  const out = await run("PostToolUse", { ...inputs.PostToolUse!, session: "ses_tool0001" });
  assert.equal(out, '{"context":"📨 agentsocks: new message from a Claude Code session. Read it with agentsocks_read_inbox before your next step."}');
  assert.equal(await run("PostToolUse", { ...inputs.PostToolUse!, session: "ses_tool0001" }), undefined);
  assert.equal(thread("ses_tool0001").last_tool, "bash");
});

test("a prompt records what the user asked, redacted, and a prompt that is one of agentsocks's own lines neither shows as the task nor resets the stop count", async () => {
  await run("SessionStart", fresh("ses_prompt001"));
  await run("UserPromptSubmit", { ...inputs.UserPromptSubmit!, session: "ses_prompt001", prompt: `deploy with ${GITHUB_PAT} please` });
  assert.doesNotMatch(thread("ses_prompt001").current_task ?? "", /ghp_/);
  assert.match(thread("ses_prompt001").current_task ?? "", /deploy with/);
  assert.equal(thread("ses_prompt001").state, "busy");
  broker.store.updateThread("opencode_ses_prompt001", { stop_streak: 2 });
  const out = await run("UserPromptSubmit", { ...inputs.UserPromptSubmit!, session: "ses_prompt001", prompt: NEW_MESSAGE });
  assert.equal(out, undefined);
  assert.equal(thread("ses_prompt001").stop_streak, 2);
  assert.match(thread("ses_prompt001").current_task ?? "", /deploy with/);
  await run("UserPromptSubmit", { ...inputs.UserPromptSubmit!, session: "ses_prompt001", prompt: "something the user typed" });
  assert.equal(thread("ses_prompt001").stop_streak, 0);
});

test("when the session goes idle with a message unread the nudge is printed as a block line, once per message, three in a row at most, and then the session is let go idle", async () => {
  await run("SessionStart", fresh("ses_stop00001"));
  const stop = { ...inputs.Stop!, session: "ses_stop00001" };
  assert.equal(await run("Stop", stop), undefined, "nothing waits");
  const outcomes: (string | undefined)[] = [];
  for (let round = 0; round < STOP_STREAK_LIMIT + 1; round++) {
    unread("ses_stop00001", `s-${round}`);
    const block = await run("Stop", stop);
    outcomes.push(block);
    if (block) await run("UserPromptSubmit", { ...inputs.UserPromptSubmit!, session: "ses_stop00001", prompt: JSON.parse(block).block });
  }
  const line = '{"block":"📨 agentsocks: before you finish, read the new message from a Claude Code session with agentsocks_read_inbox."}';
  assert.deepEqual(outcomes, [line, line, line, undefined]);
  assert.equal(thread("ses_stop00001").state, "idle", "at the limit the session is let go idle, and the wake path takes over");
  assert.equal(await run("Stop", stop), line, "the message the limit held back is announced at the next idle, with a fresh count");
  assert.equal(await run("Stop", stop), undefined, "and once announced it is not announced again");
});

test("a session end marks the thread ended and prints nothing", async () => {
  await run("SessionStart", fresh("ses_end000001"));
  assert.equal(await run("SessionEnd", { ...inputs.SessionEnd!, session: "ses_end000001" }), undefined);
  assert.equal(thread("ses_end000001").state, "ended");
});

test("no hook output carries a waiting message's text, even when the broker's reply has other lines in it", async () => {
  const lying = async (): Promise<HookResult> => ({ context: `an introduction\n${NEW_MESSAGE}\n${SECRET_BODY}`, block: `${SECRET_BODY}\n📨 agentsocks: before you finish, read the new message.` });
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    const out = (await run(event, inputs[event], lying)) ?? "";
    assert.doesNotMatch(out, /sk-live|rm -rf|introduction/, event);
    assert.match(out, /📨 agentsocks:/, event);
  }
  const silent = async (): Promise<HookResult> => ({ context: SECRET_BODY, block: SECRET_BODY });
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) assert.equal(await run(event, inputs[event], silent), undefined, event);
});

test("an unknown event, a missing or unusable session id, or an input of the wrong shape prints nothing and never reaches the broker", async () => {
  const calls: HookRequest[] = [];
  const spy = async (req: HookRequest): Promise<HookResult> => {
    calls.push(req);
    return {};
  };
  assert.equal(await run("Bogus", inputs.SessionStart, spy), undefined);
  assert.equal(await run("constructor", inputs.SessionStart, spy), undefined);
  assert.equal(await run("__proto__", inputs.SessionStart, spy), undefined);
  assert.equal(await run("", inputs.SessionStart, spy), undefined);
  for (const session of [undefined, null, 7, {}, [], "", "../x", "a b", "x".repeat(65)]) assert.equal(await run("SessionStart", { session }, spy), undefined, JSON.stringify(session));
  assert.equal(await run("PostToolUse", {}, spy), undefined);
  assert.deepEqual(calls, []);
});

test("an input field of the wrong type is dropped, not trusted: a sink that is not one is not recorded and an odd cwd or tool name does not break the call", async () => {
  await run("SessionStart", { session: "ses_odd000001", remote: "short", cwd: 42 });
  assert.equal(thread("ses_odd000001").remote, null);
  assert.equal(await run("PostToolUse", { session: "ses_odd000001", tool: { name: "x" } }), undefined);
  assert.equal(thread("ses_odd000001").last_tool, null);
});

test("the hook command prints nothing and writes no output when the input is not JSON, when it is empty, or when the kill switch is on", async () => {
  const calls: HookRequest[] = [];
  const spy = async (req: HookRequest): Promise<HookResult> => {
    calls.push(req);
    return { context: NEW_MESSAGE };
  };
  assert.equal(await runAgentHook(opencodeAgent, "PostToolUse", spy, async () => "{not json"), undefined);
  assert.equal(await runAgentHook(opencodeAgent, "PostToolUse", spy, async () => ""), undefined);
  assert.equal(await runAgentHook(opencodeAgent, "PostToolUse", spy, async () => "[1,2]"), undefined);
  assert.deepEqual(calls, []);
  assert.equal(await runAgentHook(opencodeAgent, "PostToolUse", spy, async () => JSON.stringify(inputs.PostToolUse)), JSON.stringify({ context: NEW_MESSAGE }));
  process.env.AGENTSOCKS_OFF = "1";
  try {
    assert.equal(await runAgentHook(opencodeAgent, "PostToolUse", spy, async () => JSON.stringify(inputs.PostToolUse)), undefined);
    assert.equal(await runAgentHook(opencodeAgent, "wake", spy, async () => JSON.stringify({ sink: "0123456789abcdef01234567", timeoutMs: 50 })), undefined);
  } finally {
    delete process.env.AGENTSOCKS_OFF;
  }
  assert.equal(calls.length, 1);
});

test("a hook that cannot reach the broker raises nothing to the agent: the command prints nothing", async () => {
  const down = async (): Promise<HookResult> => {
    throw new Error("agentsocks broker did not start");
  };
  assert.equal(await runAgentHook(opencodeAgent, "PostToolUse", down, async () => JSON.stringify(inputs.PostToolUse)), undefined);
});

test("the wake poll prints the wakes as JSON and an empty list when its time is up; a bad sink or a broker that is down prints nothing", async () => {
  const sink = "fedcba9876543210fedcba98";
  assert.equal(await run("wake", { sink, timeoutMs: 80 }), '{"wakes":[]}');
  await run("SessionStart", { session: "ses_poll00001", remote: sink });
  await run("Stop", { session: "ses_poll00001", remote: sink });
  const pending = run("wake", { sink, timeoutMs: 5000 });
  await sleep(50);
  const t = thread("ses_poll00001");
  assert.deepEqual(await opencodeAgent.wake!({ broker, thread: t, line: "📨 agentsocks: new message from a Claude Code session. Read it with agentsocks_read_inbox." }), { ok: true });
  assert.equal(await pending, JSON.stringify({ wakes: [{ session: "ses_poll00001", line: "📨 agentsocks: new message from a Claude Code session. Read it with agentsocks_read_inbox." }] }));
  assert.equal(await run("wake", { sink: "no", timeoutMs: 50 }), undefined);
  assert.equal(await run("wake", {}), undefined);

  const saved = process.env.AGENTSOCKS_RUNTIME_DIR;
  process.env.AGENTSOCKS_RUNTIME_DIR = tempDir("agentsocks-nobroker-");
  try {
    assert.equal(await run("wake", { sink, timeoutMs: 50 }), undefined);
  } finally {
    process.env.AGENTSOCKS_RUNTIME_DIR = saved;
  }
});
