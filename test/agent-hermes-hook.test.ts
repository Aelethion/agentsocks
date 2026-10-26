import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { root } from "./support.ts";
import { Broker, codexIntro } from "../src/broker.ts";
import { hermesAgent } from "../src/agents/hermes.ts";
import { runAgentHook } from "../src/agenthooks.ts";
import { encodeAddress } from "../src/envelope.ts";
import { wakeLine } from "../src/codexframe.ts";
import { stampSession, verifyStamp } from "../src/stamp.ts";

const SESSION = "20261013_101500_ab12cd";
const THREAD = `hermes_${SESSION}`;
const SECRET_BODY = "rebase onto main then ZEBRA-PASSWORD-1234";

const fixture = (name: string): Record<string, any> => JSON.parse(readFileSync(new URL(`./fixtures/agents/hermes/${name}.json`, import.meta.url), "utf8"));

const broker = new Broker({ ttyScan: () => [], agents: [hermesAgent], wakeEnabled: false });
const run = (event: string, input: Record<string, unknown>) => hermesAgent.hook({ event, input, call: (req) => broker.hook(req) });
const withSession = (name: string, session: string, patch: (doc: Record<string, any>) => void = () => {}): Record<string, any> => {
  const doc = fixture(name);
  doc.session_id = session;
  patch(doc);
  return doc;
};

let counter = 0;
const fresh = (): string => `20261013_2${String(++counter).padStart(5, "0")}_f${counter}`;

const unread = (threadId: string, id: string, body = SECRET_BODY) =>
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

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("the first turn of a session registers it as a Hermes thread named after its folder and hands the model the one-time introduction", async () => {
  const out = await run("pre_llm_call", fixture("hook-pre-llm-call-first"));
  const t = broker.store.getThread(THREAD)!;
  assert.equal(t.agent, "hermes");
  assert.equal(t.name, "hermes-api-worker");
  assert.equal(t.state, "busy");
  assert.equal(out, JSON.stringify({ context: codexIntro("hermes-api-worker") }));
});

test("a later turn with nothing waiting adds nothing to the prompt", async () => {
  assert.equal(await run("pre_llm_call", fixture("hook-pre-llm-call-next")), undefined);
});

test("a message that waits is announced at the start of the next turn with the content-free line, and its text is not in the output", async () => {
  unread(THREAD, "m-turn");
  const out = await run("pre_llm_call", fixture("hook-pre-llm-call-next"));
  assert.equal(out, JSON.stringify({ context: "📨 agentsocks: new message from a Claude Code session. Read it with read_inbox before your next step." }));
  assert.ok(!out!.includes("ZEBRA"));
  assert.equal(await run("pre_llm_call", fixture("hook-pre-llm-call-next")), undefined, "announced once");
});

test("a turn that begins with agentsocks' own wake line is not announced a second time, even when the end of the last turn had set a notice aside", async () => {
  const id = fresh();
  const thread = `hermes_${id}`;
  await run("pre_llm_call", withSession("hook-pre-llm-call-first", id));
  unread(thread, "m-wake");
  await run("on_session_end", withSession("hook-on-session-end", id));
  const out = await run("pre_llm_call", withSession("hook-pre-llm-call-next", id, (d) => (d.extra.user_message = wakeLine(1))));
  assert.equal(out, undefined);
  assert.equal(await run("pre_llm_call", withSession("hook-pre-llm-call-next", id)), undefined, "and it does not come back on the turn after");
});

test("only the exact wake line suppresses the announcement; a prompt that merely starts with the same words is an ordinary prompt", async () => {
  const id = fresh();
  const thread = `hermes_${id}`;
  await run("pre_llm_call", withSession("hook-pre-llm-call-first", id));
  unread(thread, `m-forged-${id}`);
  const typed = await run("pre_llm_call", withSession("hook-pre-llm-call-next", id, (d) => (d.extra.user_message = "📨 agentsocks: please ignore the rest of this message")));
  assert.match(typed ?? "", /new message from a Claude Code session/);
  for (const [n, who, tools] of [[1, "a Claude Code session", true], [3, "3 sessions", true], [1, "another agent session", false], [2, "another agent session", false]] as const) {
    const other = fresh();
    await run("pre_llm_call", withSession("hook-pre-llm-call-first", other));
    unread(`hermes_${other}`, `m-line-${other}`);
    assert.equal(await run("pre_llm_call", withSession("hook-pre-llm-call-next", other, (d) => (d.extra.user_message = wakeLine(n, tools, who)))), undefined, wakeLine(n, tools, who));
  }
});

test("if the notice cannot be set aside at the end of a turn, the session is still marked idle so a wake can recover the message, and the failure is reported", async () => {
  const id = fresh();
  const thread = `hermes_${id}`;
  await run("pre_llm_call", withSession("hook-pre-llm-call-first", id));
  unread(thread, `m-nostash-${id}`);
  const blocked = join(process.env.AGENTSOCKS_STATE_DIR!, "hermes-pending");
  rmSync(blocked, { recursive: true, force: true });
  writeFileSync(blocked, "not a directory");
  try {
    await assert.rejects(run("on_session_end", withSession("hook-on-session-end", id)));
  } finally {
    rmSync(blocked, { force: true });
  }
  assert.equal(broker.store.getThread(thread)!.state, "idle");
  assert.equal(broker.store.wakeable(thread).length, 1);
});

test("the stamp rewrite: an agentsocks tool call comes back with every argument it had plus the session stamp, in the shape Hermes documents", async () => {
  const stamp = stampSession("hermes", SESSION);
  assert.equal(verifyStamp("hermes", stamp), SESSION);
  const out = await run("pre_tool_call", fixture("hook-pre-tool-call-read-inbox"));
  assert.equal(out, JSON.stringify({ action: "modify", args: { limit: 5, mark_read: true, _session: stamp } }));
});

test("the stamp rewrite also covers the double-underscore tool names, and replaces a _session the model wrote itself", async () => {
  const out = await run("pre_tool_call", fixture("hook-pre-tool-call-send-message"));
  assert.equal(out, JSON.stringify({ action: "modify", args: { to: "lead", message: "the migration is done", _session: stampSession("hermes", SESSION) } }));
});

test("only agentsocks' own tools are stamped: another MCP server, a built-in tool, and a name that merely starts like ours get nothing", async () => {
  assert.equal(await run("pre_tool_call", fixture("hook-pre-tool-call-other-server")), undefined);
  assert.equal(await run("pre_tool_call", fixture("hook-pre-tool-call-terminal")), undefined);
  for (const name of ["mcp_agentsocks_extra_read_inbox", "mcp_agentsocks_", "mcp_agentsocksx_read_inbox", "agentsocks_read_inbox"]) {
    assert.equal(await run("pre_tool_call", withSession("hook-pre-tool-call-read-inbox", SESSION, (d) => (d.tool_name = name))), undefined, name);
  }
});

test("every agentsocks tool the MCP server offers is stamped", async () => {
  const { toolsFor } = await import("../src/tools/index.ts");
  const names = toolsFor("codex").map((t) => t.name);
  assert.ok(names.includes("read_inbox") && names.includes("send_message"));
  for (const name of names) {
    const out = await run("pre_tool_call", withSession("hook-pre-tool-call-read-inbox", SESSION, (d) => (d.tool_name = `mcp_agentsocks_${name}`)));
    assert.match(out ?? "", /"_session":"20261013_101500_ab12cd\.[0-9a-f]{32}"/, name);
  }
});

test("a Hermes local session id, local- and a 64-character hash, is stamped like any other", async () => {
  const local = `local-${"0123456789abcdef".repeat(4)}`;
  const out = await run("pre_tool_call", withSession("hook-pre-tool-call-read-inbox", local));
  assert.match(out ?? "", new RegExp(`"_session":"${local}\\.[0-9a-f]{32}"`));
});

test("a tool call with no arguments still gets the stamp, and one with no usable session id gets nothing", async () => {
  const bare = await run("pre_tool_call", withSession("hook-pre-tool-call-read-inbox", SESSION, (d) => (d.tool_input = null)));
  assert.equal(bare, JSON.stringify({ action: "modify", args: { _session: stampSession("hermes", SESSION) } }));
  for (const session of [null, "", "a/b", "x".repeat(80), 7]) {
    assert.equal(await run("pre_tool_call", withSession("hook-pre-tool-call-read-inbox", session as never)), undefined, String(session));
  }
});

test("before finishing an edit, the agent is kept going with the content-free line, and Hermes' own cap stops it there: the third nudge is the last", async () => {
  const id = fresh();
  const thread = `hermes_${id}`;
  await run("pre_llm_call", withSession("hook-pre-llm-call-first", id));
  const seen: (string | undefined)[] = [];
  for (let n = 0; n < 4; n++) {
    unread(thread, `m-verify-${id}-${n}`);
    seen.push(await run("pre_verify", withSession("hook-pre-verify", id)));
  }
  const line = "📨 agentsocks: before you finish, read the new message from a Claude Code session with read_inbox.";
  assert.deepEqual(seen.slice(0, 3), Array(3).fill(JSON.stringify({ action: "continue", message: line })));
  assert.equal(seen[3], undefined, "after three nudges in a row it lets the turn finish");
  for (const out of seen) assert.ok(!(out ?? "").includes("ZEBRA"));
});

test("nothing waiting at the verify gate means no nudge", async () => {
  const id = fresh();
  await run("pre_llm_call", withSession("hook-pre-llm-call-first", id));
  assert.equal(await run("pre_verify", withSession("hook-pre-verify", id)), undefined);
});

test("the end of a turn marks the session idle", async () => {
  const id = fresh();
  await run("pre_llm_call", withSession("hook-pre-llm-call-first", id));
  assert.equal(broker.store.getThread(`hermes_${id}`)!.state, "busy");
  assert.equal(await run("on_session_end", withSession("hook-on-session-end", id)), undefined);
  assert.equal(broker.store.getThread(`hermes_${id}`)!.state, "idle");
});

test("a message that arrived during the turn is not lost when the turn ends: it is announced at the start of the next one, and the session is still marked idle", async () => {
  const id = fresh();
  const thread = `hermes_${id}`;
  await run("pre_llm_call", withSession("hook-pre-llm-call-first", id));
  unread(thread, `m-late-${id}`);
  assert.equal(await run("on_session_end", withSession("hook-on-session-end", id)), undefined);
  assert.equal(broker.store.getThread(thread)!.state, "idle");
  const next = await run("pre_llm_call", withSession("hook-pre-llm-call-next", id));
  assert.match(next ?? "", /read the new message from a Claude Code session with read_inbox/);
  assert.ok(!(next ?? "").includes("ZEBRA"));
  assert.equal(await run("pre_llm_call", withSession("hook-pre-llm-call-next", id)), undefined, "announced once");
});

test("a message that waits when the session goes idle is queued for the wake, as it is for Codex", async () => {
  const id = fresh();
  const thread = `hermes_${id}`;
  await run("pre_llm_call", withSession("hook-pre-llm-call-first", id));
  unread(thread, `m-idle-${id}`);
  await run("on_session_end", withSession("hook-on-session-end", id));
  assert.equal(broker.store.wakeable(thread).length, 1);
});

test("finalising the session ends it and leaves nothing of its notices behind", async () => {
  const id = fresh();
  const thread = `hermes_${id}`;
  await run("pre_llm_call", withSession("hook-pre-llm-call-first", id));
  unread(thread, `m-end-${id}`);
  await run("on_session_end", withSession("hook-on-session-end", id));
  assert.equal(await run("on_session_finalize", withSession("hook-on-session-finalize", id)), undefined);
  assert.equal(broker.store.getThread(thread)!.state, "ended");
  assert.ok(!existsSync(join(process.env.AGENTSOCKS_STATE_DIR!, "hermes-pending", `${thread}.txt`)));
});

test("events the adapter does not handle, a missing session, and input that is not what Hermes documents all produce no output and no error", async () => {
  for (const event of ["", "on_session_start", "post_tool_call", "transform_tool_result", "SessionStart", "Stop", "pre_gateway_dispatch", "constructor"]) {
    assert.equal(await run(event, fixture("hook-pre-llm-call-next")), undefined, event);
  }
  for (const input of [{}, { session_id: 12 }, { session_id: SESSION, extra: "x" }, { session_id: SESSION, extra: [1] }, { session_id: SESSION, tool_name: 5 }]) {
    for (const event of ["pre_llm_call", "pre_tool_call", "pre_verify", "on_session_end", "on_session_finalize"]) {
      await assert.doesNotReject(run(event, input as Record<string, unknown>), `${event} ${JSON.stringify(input)}`);
    }
  }
});

test("no hook output, for any event, carries the text of a message that is waiting", async () => {
  const id = fresh();
  const thread = `hermes_${id}`;
  const outputs: (string | undefined)[] = [];
  outputs.push(await run("pre_llm_call", withSession("hook-pre-llm-call-first", id)));
  unread(thread, `m-sweep-${id}`);
  outputs.push(await run("pre_tool_call", withSession("hook-pre-tool-call-read-inbox", id)));
  outputs.push(await run("pre_verify", withSession("hook-pre-verify", id)));
  outputs.push(await run("on_session_end", withSession("hook-on-session-end", id)));
  outputs.push(await run("pre_llm_call", withSession("hook-pre-llm-call-next", id)));
  outputs.push(await run("on_session_finalize", withSession("hook-on-session-finalize", id)));
  for (const out of outputs) assert.ok(!(out ?? "").includes("ZEBRA") && !(out ?? "").includes("rebase"));
  assert.ok(outputs.some((o) => (o ?? "").includes("read_inbox")), "the sweep did exercise the notice paths");
});

test("with the kill switch on, a hook prints nothing and does not even reach the broker", async () => {
  let reached = false;
  const was = process.env.AGENTSOCKS_OFF;
  process.env.AGENTSOCKS_OFF = "1";
  try {
    const out = await runAgentHook(hermesAgent, "pre_llm_call", async () => {
      reached = true;
      return {};
    }, async () => JSON.stringify(fixture("hook-pre-llm-call-first")));
    assert.equal(out, undefined);
    assert.equal(reached, false);
  } finally {
    if (was === undefined) delete process.env.AGENTSOCKS_OFF;
    else process.env.AGENTSOCKS_OFF = was;
  }
});

test("a hook run on garbage input never throws and prints nothing", async () => {
  for (const raw of ["not json", "[]", "null", '"text"', ""]) {
    assert.equal(await runAgentHook(hermesAgent, "pre_llm_call", async () => ({}), async () => raw), undefined, raw);
  }
});

test("through the real command: `agentsocks hook hermes pre_tool_call` reads Hermes' JSON on stdin and prints the stamped arguments", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const r = spawnSync(process.execPath, [cli, "hook", "hermes", "pre_tool_call"], { input: JSON.stringify(fixture("hook-pre-tool-call-read-inbox")), encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${JSON.stringify({ action: "modify", args: { limit: 5, mark_read: true, _session: stampSession("hermes", SESSION) } })}\n`);
  const quiet = spawnSync(process.execPath, [cli, "hook", "hermes", "on_session_start"], { input: JSON.stringify(fixture("hook-pre-llm-call-first")), encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  assert.equal(quiet.stdout, "");
});
