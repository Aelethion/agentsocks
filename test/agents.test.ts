import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root, wakeLog } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { AGENT_IDS, agentOfThreadId, agents, agentSpec, threadIdFor, type AgentSpec, type WakeOutcome } from "../src/agents/index.ts";
import { encodeAddress } from "../src/envelope.ts";

const woken: { threadId: string; line: string }[] = [];
let wakeResult: WakeOutcome = { ok: true };

const inertInstaller: AgentSpec["installer"] = {
  detect: () => false,
  install: () => {},
  uninstall: () => {},
  status: () => ({ state: "not installed", detail: [] }),
};

const pushy: AgentSpec = {
  id: "opencode",
  live: "untested",
  hook: async () => undefined,
  wake: async ({ thread, line }) => {
    woken.push({ threadId: thread.thread_id, line });
    return wakeResult;
  },
  installer: inertInstaller,
};

let sometimesReady = false;
const sometimesCalls: string[] = [];
const sometimes: AgentSpec = {
  id: "hermes",
  live: "untested",
  hook: async () => undefined,
  wake: async ({ thread }) => {
    sometimesCalls.push(thread.thread_id);
    return { ok: true };
  },
  canWake: () => sometimesReady,
  installer: inertInstaller,
};

const pullOnly: AgentSpec = { id: "cursor", live: "untested", hook: async () => undefined, installer: inertInstaller };

const broker = new Broker({ ttyScan: () => [], agents: [pushy, pullOnly, sometimes] });
const auditEvents = (event: string) => {
  const file = join(process.env.AGENTSOCKS_STATE_DIR!, "audit.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.includes(`"event":"${event}"`)) : [];
};
const wakesOfCodex = () => (existsSync(wakeLog) ? readFileSync(wakeLog, "utf8").split("\n").filter((l) => l.startsWith("queue")).length : 0);
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

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("an agent registry refuses a second entry for one agent and any id that is not an inbox agent", () => {
  assert.throws(() => agents([pushy], [pushy]), /opencode is registered twice/);
  assert.throws(() => agents([{ ...pushy, id: "codex" as never }]), /codex is not an inbox agent/);
  assert.throws(() => agents([{ ...pushy, id: "vim" as never }]), /vim is not an inbox agent/);
  assert.equal(agentSpec("cursor", [pushy, pullOnly]), pullOnly);
  assert.equal(agentSpec("codex", [pushy, pullOnly]), undefined);
});

test("a session id becomes a thread id the agent's name prefixes, so two agents can never share an inbox, and a bad id is refused", () => {
  assert.equal(threadIdFor("hermes", "20261013_101500_ab12cd"), "hermes_20261013_101500_ab12cd");
  assert.equal(threadIdFor("codex", "019e2f00-aaaa"), "019e2f00-aaaa");
  assert.notEqual(threadIdFor("cursor", "abc"), threadIdFor("gemini", "abc"));
  for (const bad of ["", "a/b", "../x", "x".repeat(65), "a b", undefined, 7]) assert.equal(threadIdFor("cursor", bad), undefined, String(bad));
});

test("a session that registers through an agent's hook is a thread of that agent, named after its folder, with no Codex lookup", async () => {
  await broker.hook({ threadId: "opencode_ses_1", agent: "opencode", event: "SessionStart", cwd: "/work/api-worker" });
  const t = broker.store.getThread("opencode_ses_1")!;
  assert.equal(t.agent, "opencode");
  assert.equal(t.name, "opencode-api-worker");
  assert.equal(t.subagent, 0);
  assert.equal(broker.describe(t).agent, "opencode");
  await broker.hook({ threadId: "019e2f00-0000-7000-8000-000000000001", event: "SessionStart", cwd: "/work/web" });
  assert.equal(broker.store.getThread("019e2f00-0000-7000-8000-000000000001")!.agent, "codex");
});

test("a pull-only agent is told by the same content-free notices as Codex, at its next tool call and before it finishes, and is never woken", async () => {
  const id = "cursor_conv_1";
  await broker.hook({ threadId: id, agent: "cursor", event: "SessionStart", cwd: "/work/cursor-proj" });
  await broker.hook({ threadId: id, agent: "cursor", event: "Stop" });
  const codexBefore = wakesOfCodex();
  unread(id, "please check the migration", "pull-1");
  const tool = await broker.hook({ threadId: id, agent: "cursor", event: "PostToolUse", toolName: "Read" });
  assert.match(tool.context ?? "", /^📨 agentsocks: new message from a Claude Code session\. Read it with read_inbox before your next step\.$/);
  unread(id, "and the rollback too", "pull-2");
  const stop = await broker.hook({ threadId: id, agent: "cursor", event: "Stop" });
  assert.match(stop.block ?? "", /before you finish, read the 2 new messages from a Claude Code session with read_inbox/);
  assert.doesNotMatch(`${tool.context}${stop.block}`, /migration|rollback/, "peer text never rides in a hook");
  await broker.wake(id, Date.now() + 5000);
  assert.equal(wakesOfCodex(), codexBefore, "codex queue is not used for another agent");
  assert.equal(auditEvents("wake_failed").filter((l) => l.includes(id)).length, 0, "a pull-only agent is not a failed wake");
  assert.equal(broker.store.getThread(id)!.pending_wake_at, null);
});

test("an idle session of an agent that can be woken is woken through that agent, with the same content-free line and the same accounting as Codex", async () => {
  const id = "opencode_ses_wake";
  await broker.hook({ threadId: id, agent: "opencode", event: "SessionStart", cwd: "/work/wakeme", remote: "sink-1" });
  await broker.hook({ threadId: id, agent: "opencode", event: "Stop" });
  unread(id, "ping", "wake-1");
  const codexBefore = wakesOfCodex();
  woken.length = 0;
  await broker.wake(id, Date.now() + 5000);
  assert.deepEqual(woken, [{ threadId: id, line: "📨 agentsocks: new message from a Claude Code session. Read it with read_inbox." }]);
  assert.equal(JSON.parse(broker.store.getThread(id)!.wake_log).length, 1);
  assert.equal(auditEvents("wake").filter((l) => l.includes(id)).length, 1);
  assert.equal(wakesOfCodex(), codexBefore);
});

test("a wake the agent cannot deliver backs off like a failed Codex wake and is not counted", async () => {
  const id = "opencode_ses_down";
  await broker.hook({ threadId: id, agent: "opencode", event: "SessionStart", cwd: "/work/down" });
  await broker.hook({ threadId: id, agent: "opencode", event: "Stop" });
  unread(id, "ping", "down-1");
  wakeResult = { ok: false, detail: "no wake route" };
  woken.length = 0;
  try {
    const at = Date.now() + 5000;
    await broker.wake(id, at);
    await broker.wake(id, at + 10_000);
    assert.equal(woken.length, 1, "inside the 30 s backoff nothing is attempted again");
    assert.equal(JSON.parse(broker.store.getThread(id)!.wake_log).length, 0);
    assert.equal(broker.store.getThread(id)!.pending_wake_at, null);
    assert.match(auditEvents("wake_failed").filter((l) => l.includes(id))[0] ?? "", /no wake route/);
  } finally {
    wakeResult = { ok: true };
  }
});

const recording = (id: AgentSpec["id"], found: boolean, calls: string[], fail = false): AgentSpec => ({
  id,
  live: "untested",
  hook: async () => undefined,
  installer: {
    detect: () => found,
    install: (ctx) => {
      calls.push(`install ${id}${ctx.dryRun ? " dry" : ""}`);
      if (fail) throw new Error("config is not valid JSON");
      ctx.log.push(`${id}: wired`);
    },
    uninstall: () => void calls.push(`uninstall ${id}`),
    status: () => ({ state: found ? "wired" : "not installed", detail: [] }),
  },
});

test("install wires the agents it finds and names the ones it skipped; naming an agent wires it even when it is not found; one failing installer does not stop the rest", async () => {
  const { installAgents, uninstallAgents, agentReports } = await import("../src/install.ts");
  const calls: string[] = [];
  const registry = [recording("opencode", true, calls), recording("hermes", false, calls), recording("cursor", true, calls, true), recording("gemini", true, calls)];
  const log: string[] = [];
  installAgents("detected", false, log, registry);
  assert.deepEqual(calls, ["install opencode", "install cursor", "install gemini"]);
  assert.deepEqual(log, ["opencode: wired", "hermes: not installed on this machine, skipped", "cursor: not wired (config is not valid JSON)", "gemini: wired"]);

  calls.length = 0;
  installAgents(["hermes"], true, [], registry);
  assert.deepEqual(calls, ["install hermes dry"]);

  calls.length = 0;
  uninstallAgents(false, [], registry);
  assert.deepEqual(calls, ["uninstall opencode", "uninstall hermes", "uninstall cursor", "uninstall gemini"]);
  assert.deepEqual(
    agentReports(registry).map((r) => `${r.id}:${r.status.state}`),
    ["opencode:wired", "hermes:not installed", "cursor:wired", "gemini:wired"],
  );
});

test("an agent that can only sometimes be woken is left alone, with no failure recorded, while it cannot", async () => {
  const id = "hermes_sess_1";
  broker.store.upsertThread(id, { agent: "hermes", state: "idle", hooks_active: 1 }, "hermes-x");
  unread(id, "ping", "s1");
  await broker.wake(id, Date.now() + 5000);
  assert.deepEqual(sometimesCalls, []);
  assert.equal(auditEvents("wake_failed").filter((l) => l.includes(id)).length, 0);
  sometimesReady = true;
  await broker.wake(id, Date.now() + 5000);
  assert.deepEqual(sometimesCalls, [id]);
});

test("every inbox agent agentsocks knows is in the registry once, with an installer", async () => {
  const { AGENTS } = await import("../src/agents/index.ts");
  assert.deepEqual(AGENTS.map((a) => a.id).sort(), ["copilot", "cursor", "gemini", "hermes", "omp", "opencode"]);
  for (const a of AGENTS) assert.equal(typeof a.installer.detect, "function", a.id);
});

test("peer_status names the agent of a session that is not Codex, and leaves Codex peers as they were", async () => {
  const { brokerCall } = await import("../src/client.ts");
  const { formatPeerStatus } = await import("../src/render.ts");
  const target = (threadId: string, name: string) => ({ kind: "codex", addr: encodeAddress(`${process.env.AGENTSOCKS_RUNTIME_DIR}/t/${threadId}.sock`), name, threadId });
  const status = await brokerCall<import("../src/status.ts").PeerStatus>("peer_status", { to: target("opencode_ses_1", "opencode-api-worker") }, { autoStart: false });
  assert.equal(status.peer.agent, "opencode");
  assert.match(formatPeerStatus(status), /^@opencode-api-worker \(opencode\) is /);
  const codex = await brokerCall<import("../src/status.ts").PeerStatus>("peer_status", { to: target("019e2f00-0000-7000-8000-000000000001", "codex-web") }, { autoStart: false });
  assert.equal(codex.peer.agent, undefined);
  assert.match(formatPeerStatus(codex), /^@codex-web \(codex\) is /);
});

const INBOX_AGENTS = AGENT_IDS.filter((a) => a !== "codex");

test("a session first registered by a tool call or a command, with no agent named, is a thread of the agent its inbox name says, for every agent", async () => {
  for (const agent of INBOX_AGENTS) {
    const id = threadIdFor(agent, `first-${agent}`)!;
    const registered = await broker.register(id, { cwd: `/work/${agent}-site` });
    assert.equal(registered.agent, agent, `${agent} by register`);
    assert.equal(broker.store.getThread(id)!.agent, agent);
    assert.equal(registered.name, `${agent}-site`, "and it is named like one");
    assert.equal(agentOfThreadId(id), agent);
    const viaOp = threadIdFor(agent, `op-${agent}`)!;
    await broker.dispatch({ op: "register", threadId: viaOp });
    assert.equal(broker.store.getThread(viaOp)!.agent, agent, `${agent} by the register op`);
    const viaWait = threadIdFor(agent, `wait-${agent}`)!;
    await broker.dispatch({ op: "set_name", threadId: viaWait, name: `named-${agent}` });
    assert.equal(broker.store.getThread(viaWait)!.agent, agent, `${agent} by set_name`);
  }
});

test("a Codex thread stays Codex, whatever shape its id has, and an id that merely contains an underscore is not an agent's", async () => {
  for (const id of ["019e2f00-0000-7000-8000-0000000000a1", "codex_thing", "foo_bar", "cursorx_1", "_cursor_1", "Cursor_1"]) {
    const t = await broker.register(id, { cwd: "/work/plain" });
    assert.equal(t.agent, "codex", id);
    assert.equal(agentOfThreadId(id), undefined, id);
  }
});

test("a later hook that names the agent corrects a thread an earlier call left on the default, and renames it if the old name was the default one", async () => {
  broker.store.upsertThread("legacy-unlabelled", {}, "codex-legacy-u");
  assert.equal(broker.store.getThread("legacy-unlabelled")!.agent, "codex");
  await broker.hook({ threadId: "legacy-unlabelled", agent: "gemini", event: "SessionStart", cwd: "/work/late" });
  const fixed = broker.store.getThread("legacy-unlabelled")!;
  assert.equal(fixed.agent, "gemini");
  assert.equal(fixed.name, "gemini-late");

  broker.store.upsertThread("cursor_legacy9", {}, "codex-legacy9");
  await broker.register("cursor_legacy9", {});
  assert.equal(broker.store.getThread("cursor_legacy9")!.agent, "cursor", "the inbox name alone is enough");

  broker.store.upsertThread("hermes_renamed", {}, "my own name");
  await broker.register("hermes_renamed", { cwd: "/work/hermes-x" });
  assert.equal(broker.store.getThread("hermes_renamed")!.name, "my own name", "a name somebody chose is left alone");
  assert.equal(broker.store.getThread("hermes_renamed")!.agent, "hermes");
});

test("the inbox name is the authority when a call names a different agent, and a thread already on an agent is not moved by a call without one", async () => {
  const t = await broker.register("opencode_mixed", { agent: "cursor" });
  assert.equal(t.agent, "opencode");
  await broker.register("opencode_mixed", {});
  await broker.register("opencode_mixed", { cwd: "/work/again" });
  assert.equal(broker.store.getThread("opencode_mixed")!.agent, "opencode");
  const unprefixed = await broker.register("plain-id-1", { agent: "copilot" });
  assert.equal(unprefixed.agent, "copilot", "an id with no prefix takes the agent the hook names");
  await broker.register("plain-id-1", {});
  assert.equal(broker.store.getThread("plain-id-1")!.agent, "copilot");
});
