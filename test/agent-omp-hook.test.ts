import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Broker, type HookRequest, type HookResult } from "../src/broker.ts";
import { runAgentHook } from "../src/agenthooks.ts";
import { ompAgent } from "../src/agents/omp.ts";
import { offerWake, sinkOf } from "../src/agents/opencode/sink.ts";
import { encodeAddress } from "../src/envelope.ts";
import { STOP_STREAK_LIMIT } from "../src/limits.ts";
import { GITHUB_PAT } from "./fakes.ts";
import { root, sleep } from "./support.ts";
import { tempDir } from "./tmp.ts";

const SECRET_BODY = "rotate the prod key sk-live-NOT-FOR-THE-MODEL and run rm -rf /tmp/x";
const NEW_MESSAGE = "📨 agentsocks: new message from a Claude Code session. Read it with agentsocks_read_inbox before your next step.";
const WAKE_LINE = "📨 agentsocks: new message from a Claude Code session. Read it with agentsocks_read_inbox.";
const SINK = "0123456789abcdef01234567";
const SESSION = "0199c1a2-7b3c-7d4e-8f50-6a7b8c9d0e1f";

const broker = new Broker({ ttyScan: () => [], agents: [ompAgent], wakeEnabled: false });
const via = (req: HookRequest): Promise<HookResult> => broker.hook(req);
const run = (event: string, input: Record<string, unknown>, call = via) => ompAgent.hook({ event, input, call });
const thread = (raw: string) => broker.store.getThread(`omp_${raw}`)!;
const unread = (raw: string, id: string, body = SECRET_BODY) =>
  broker.store.enqueue({ id, msg_id: id, to_thread: `omp_${raw}`, kind: "message", from_addr: encodeAddress(`${root}/cc-socks/ann.sock`), from_name: "ann", from_kind: "claude", from_session: null, from_mode: null, body, received_at: Date.now(), route: "now", decision: null });
const start = (raw: string, extra: Record<string, unknown> = {}) => ({ session: raw, cwd: "/work/api", remote: SINK, ...extra });

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("a session start registers the session as an OMP thread with its folder, state idle and the extension's sink, and prints nothing when nothing waits", async () => {
  assert.equal(await run("SessionStart", start(SESSION)), undefined);
  const t = thread(SESSION);
  assert.equal(t.agent, "omp");
  assert.equal(t.cwd, "/work/api");
  assert.equal(t.name, "omp-api");
  assert.equal(t.state, "idle");
  assert.equal(t.remote, SINK);
  assert.equal(t.hooks_active, 1);
  assert.equal(t.subagent, 0);
});

test("a session start with messages already waiting prints the content-free notice and nothing else", async () => {
  await run("SessionStart", start("omp-waiting-1"));
  unread("omp-waiting-1", "w-1");
  const out = await run("SessionStart", start("omp-waiting-1"));
  assert.equal(out, JSON.stringify({ context: NEW_MESSAGE }));
  assert.doesNotMatch(out ?? "", /sk-live|rm -rf|reachable as/);
});

test("a tool result with a message waiting prints the notice as JSON, once, and the next prints nothing", async () => {
  await run("SessionStart", start("omp-tool-0001"));
  assert.equal(await run("PostToolUse", { session: "omp-tool-0001", tool: "bash" }), undefined);
  unread("omp-tool-0001", "t-1");
  assert.equal(await run("PostToolUse", { session: "omp-tool-0001", tool: "bash" }), JSON.stringify({ context: NEW_MESSAGE }));
  assert.equal(await run("PostToolUse", { session: "omp-tool-0001", tool: "bash" }), undefined);
  assert.equal(thread("omp-tool-0001").last_tool, "bash");
});

test("a prompt records what the user asked, redacted, and one of agentsocks's own lines neither shows as the task nor resets the stop count", async () => {
  await run("SessionStart", start("omp-prompt-01"));
  await run("UserPromptSubmit", { session: "omp-prompt-01", prompt: `deploy with ${GITHUB_PAT} please` });
  assert.doesNotMatch(thread("omp-prompt-01").current_task ?? "", /ghp_/);
  assert.match(thread("omp-prompt-01").current_task ?? "", /deploy with/);
  assert.equal(thread("omp-prompt-01").state, "busy");
  broker.store.updateThread("omp_omp-prompt-01", { stop_streak: 2 });
  assert.equal(await run("UserPromptSubmit", { session: "omp-prompt-01", prompt: NEW_MESSAGE }), undefined);
  assert.equal(thread("omp-prompt-01").stop_streak, 2);
  assert.match(thread("omp-prompt-01").current_task ?? "", /deploy with/);
  await run("UserPromptSubmit", { session: "omp-prompt-01", prompt: "something the user typed" });
  assert.equal(thread("omp-prompt-01").stop_streak, 0);
});

test("when the agent settles with a message unread the nudge is printed as a block line, three in a row at most, and then the session is let go idle", async () => {
  await run("SessionStart", start("omp-stop-0001"));
  const stop = { session: "omp-stop-0001" };
  assert.equal(await run("Stop", stop), undefined, "nothing waits");
  const outcomes: (string | undefined)[] = [];
  for (let round = 0; round < STOP_STREAK_LIMIT + 1; round++) {
    unread("omp-stop-0001", `s-${round}`);
    const block = await run("Stop", stop);
    outcomes.push(block);
    if (block) await run("UserPromptSubmit", { session: "omp-stop-0001", prompt: JSON.parse(block).block });
  }
  const line = '{"block":"📨 agentsocks: before you finish, read the new message from a Claude Code session with agentsocks_read_inbox."}';
  assert.deepEqual(outcomes, [line, line, line, undefined]);
  assert.equal(thread("omp-stop-0001").state, "idle");
});

test("a session end marks the thread ended and prints nothing", async () => {
  await run("SessionStart", start("omp-end-00001"));
  assert.equal(await run("SessionEnd", { session: "omp-end-00001" }), undefined);
  assert.equal(thread("omp-end-00001").state, "ended");
});

test("no hook output carries a waiting message's text, even when the broker's reply has other lines in it", async () => {
  const lying = async (): Promise<HookResult> => ({ context: `an introduction\n${NEW_MESSAGE}\n${SECRET_BODY}`, block: `${SECRET_BODY}\n📨 agentsocks: before you finish, read the new message.` });
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    const out = (await run(event, start(SESSION), lying)) ?? "";
    assert.doesNotMatch(out, /sk-live|rm -rf|introduction/, event);
    assert.match(out, /📨 agentsocks:/, event);
  }
  const silent = async (): Promise<HookResult> => ({ context: SECRET_BODY, block: SECRET_BODY });
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) assert.equal(await run(event, start(SESSION), silent), undefined, event);
});

test("an unknown event, a missing or unusable session id, or an input of the wrong shape prints nothing and never reaches the broker", async () => {
  const calls: HookRequest[] = [];
  const spy = async (req: HookRequest): Promise<HookResult> => {
    calls.push(req);
    return {};
  };
  for (const event of ["Bogus", "constructor", "__proto__", ""]) assert.equal(await run(event, start(SESSION), spy), undefined, event);
  for (const session of [undefined, null, 7, {}, [], "", "../x", "a b", "x".repeat(80)]) assert.equal(await run("SessionStart", { session }, spy), undefined, JSON.stringify(session));
  assert.equal(await run("PostToolUse", {}, spy), undefined);
  assert.deepEqual(calls, []);
});

test("an input field of the wrong type is dropped, not trusted: a sink that is not one is not recorded and an odd cwd or tool name does not break the call", async () => {
  await run("SessionStart", { session: "omp-odd-00001", remote: "short", cwd: 42 });
  assert.equal(thread("omp-odd-00001").remote, null);
  assert.equal(await run("PostToolUse", { session: "omp-odd-00001", tool: { name: "x" } }), undefined);
  assert.equal(thread("omp-odd-00001").last_tool, null);
});

test("the hook command prints nothing when the input is not JSON, when it is empty, or when the kill switch is on, and nothing when the broker is down", async () => {
  const calls: HookRequest[] = [];
  const spy = async (req: HookRequest): Promise<HookResult> => {
    calls.push(req);
    return { context: NEW_MESSAGE };
  };
  assert.equal(await runAgentHook(ompAgent, "PostToolUse", spy, async () => "{not json"), undefined);
  assert.equal(await runAgentHook(ompAgent, "PostToolUse", spy, async () => ""), undefined);
  assert.equal(await runAgentHook(ompAgent, "PostToolUse", spy, async () => "[1,2]"), undefined);
  assert.deepEqual(calls, []);
  const input = JSON.stringify(start(SESSION, { tool: "read" }));
  assert.equal(await runAgentHook(ompAgent, "PostToolUse", spy, async () => input), JSON.stringify({ context: NEW_MESSAGE }));
  process.env.AGENTSOCKS_OFF = "1";
  try {
    assert.equal(await runAgentHook(ompAgent, "PostToolUse", spy, async () => input), undefined);
    assert.equal(await runAgentHook(ompAgent, "wake", spy, async () => JSON.stringify({ sink: SINK, timeoutMs: 50 })), undefined);
  } finally {
    delete process.env.AGENTSOCKS_OFF;
  }
  assert.equal(calls.length, 1);
  const down = async (): Promise<HookResult> => {
    throw new Error("agentsocks broker did not start");
  };
  assert.equal(await runAgentHook(ompAgent, "PostToolUse", down, async () => input), undefined);
});

test("the wake poll prints the wakes as JSON, session and line only, and an empty list when its time is up; a bad sink or a broker that is down prints nothing", async () => {
  const sink = "fedcba9876543210fedcba98";
  assert.equal(await run("wake", { sink, timeoutMs: 80 }), '{"wakes":[]}');
  await run("SessionStart", { session: "omp-poll-00001", remote: sink });
  await run("Stop", { session: "omp-poll-00001", remote: sink });
  const pending = run("wake", { sink, timeoutMs: 5000 });
  await sleep(50);
  assert.deepEqual(await ompAgent.wake!({ broker, thread: thread("omp-poll-00001"), line: WAKE_LINE }), { ok: true });
  assert.equal(await pending, JSON.stringify({ wakes: [{ session: "omp-poll-00001", line: WAKE_LINE }] }));
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

test("a wake goes to the extension that polled in the last 35 s and to no one else: no sink, an unknown sink, or a thread without one is refused with a reason", async () => {
  await run("SessionStart", start("omp-nosink-001", { remote: undefined }));
  const refused = await ompAgent.wake!({ broker, thread: thread("omp-nosink-001"), line: WAKE_LINE });
  assert.equal(refused.ok, false);
  await run("SessionStart", start("omp-nopoll-001", { remote: "aaaaaaaabbbbbbbbccccccc1" }));
  assert.equal((await ompAgent.wake!({ broker, thread: thread("omp-nopoll-001"), line: WAKE_LINE })).ok, false, "nobody polls that sink");
  const opencodeThread = { ...thread(SESSION), thread_id: "opencode_ses_x" };
  assert.equal((await ompAgent.wake!({ broker, thread: opencodeThread, line: WAKE_LINE })).ok, false, "not an OMP thread");
});

test("a queued wake for an OMP session that has since ended is dropped by the sink, as one for an OpenCode session is", async () => {
  const sink = "1111222233334444aaaabbbb";
  await run("SessionStart", { session: "omp-gone-00001", remote: sink });
  await run("SessionStart", { session: "omp-live-00001", remote: sink });
  await run("wake", { sink, timeoutMs: 20 });
  assert.equal(offerWake(broker, sink, { session: "omp-gone-00001", line: WAKE_LINE, agent: "omp" }), true);
  assert.equal(offerWake(broker, sink, { session: "omp-live-00001", line: WAKE_LINE, agent: "omp" }), true);
  await run("SessionEnd", { session: "omp-gone-00001" });
  assert.equal(await run("wake", { sink, timeoutMs: 0 }), JSON.stringify({ wakes: [{ session: "omp-live-00001", line: WAKE_LINE }] }));
  assert.equal(sinkOf(broker, sink)?.queue.length, 0);
});
