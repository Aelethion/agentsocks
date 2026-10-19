import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { until, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { brokerCall } from "../src/client.ts";
import { messageContent, parseEnvelope } from "../src/envelope.ts";
import { AGENT_IDS, kindLabel, threadIdFor, type InboxAgentId } from "../src/agents/index.ts";
import { agentIdentity, codexIdentity, listPeers, resolvePeer, RESOLVABLE, ResolveError, type Peer } from "../src/peers.ts";
import { askSessions } from "../src/askclient.ts";
import { formatAsk } from "../src/asks.ts";
import { sendMessage } from "../src/send.ts";
import { messageStatus, stats } from "../src/ops.ts";
import { formatChannels, formatPost } from "../src/channels.ts";
import { listChannels, postToChannel, subscribeTo } from "../src/channelclient.ts";
import { formatMessageStatus, formatStats } from "../src/render.ts";
import { renderTop, topSnapshot } from "../src/top.ts";
import { formatVisible } from "../src/gateway/gtools.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const INBOX_AGENTS = AGENT_IDS.filter((a): a is InboxAgentId => a !== "codex");
const broker = new Broker({ wakeEnabled: false, ttyScan: () => [] });

async function start(agent: InboxAgentId, session: string, cwd: string): Promise<string> {
  const threadId = threadIdFor(agent, session)!;
  await broker.hook({ threadId, agent, event: "SessionStart", cwd });
  return threadId;
}

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("kindLabel names the agent for a session that is not Codex and the delivery class for everything else", () => {
  assert.equal(kindLabel("codex", "cursor"), "cursor");
  assert.equal(kindLabel("codex", "codex"), "codex");
  assert.equal(kindLabel("codex"), "codex");
  assert.equal(kindLabel("codex", null), "codex");
  assert.equal(kindLabel("claude"), "claude");
  assert.equal(kindLabel("remote", undefined), "remote");
});

test("a digest flushed to a Claude session names its sender's agent exactly as the sender's direct message did, for every agent", async () => {
  for (const agent of INBOX_AGENTS) {
    const claude = await fakeClaude(`digestalpha-${agent}`, livePid(), "idle");
    try {
      const me = await agentIdentity(agent, `digest-${agent}`, "/work/digest");
      await sendMessage(me, claude.name, "a direct message");
      claude.setStatus("busy");
      await sendMessage(me, claude.name, "FYI a digest", undefined, { urgency: "fyi" });
      claude.setStatus("idle");
      await broker.runSweep();
      await until(() => claude.frames.length === 2);
      const [direct, digest] = claude.frames.map((f) => parseEnvelope(messageContent(f))!);
      assert.equal(direct!.fromName, `${me.name} (${agent})`, `${agent} direct`);
      assert.equal(digest!.fromName, direct!.fromName, `${agent} digest`);
    } finally {
      await closeServer(claude.server);
    }
  }
});

test("a digest from a Codex session still says codex", async () => {
  const claude = await fakeClaude("digestbeta", livePid(), "busy");
  try {
    await broker.hook({ threadId: "digest-codex-1", event: "SessionStart", cwd: "/work/digestcodex" });
    const codex = await codexIdentity("digest-codex-1");
    await sendMessage(codex, claude.name, "FYI from codex", undefined, { urgency: "fyi" });
    claude.setStatus("idle");
    await broker.runSweep();
    await until(() => claude.frames.length === 1);
    assert.equal(parseEnvelope(messageContent(claude.frames[0]!))!.fromName, `${codex.name} (codex)`);
  } finally {
    await closeServer(claude.server);
  }
});

test("two sessions of different agents with one name are told apart in the ambiguity error by their agent", async () => {
  const cursorId = await start("cursor", "twin-1", "/work/twin");
  const geminiId = await start("gemini", "twin-2", "/work/twin");
  await brokerCall("set_name", { threadId: cursorId, name: "twin" });
  await brokerCall("set_name", { threadId: geminiId, name: "twin" });
  await brokerCall("set_name", { threadId: "twin-codex-1", name: "twin" });
  const peers = await listPeers(RESOLVABLE);
  assert.throws(
    () => resolvePeer(peers, "twin"),
    (err: unknown) => {
      assert.ok(err instanceof ResolveError);
      assert.match(err.message, /twin \[[0-9a-f]+\] \(cursor\)/);
      assert.match(err.message, /twin \[[0-9a-f]+\] \(gemini\)/);
      assert.match(err.message, /twin \[[0-9a-f]+\] \(codex\)/);
      return true;
    },
  );
});

test("the send command, list and list --json name the agent, and Claude and Codex keep their class", async () => {
  await start("opencode", "cli-1", "/work/clia");
  await broker.hook({ threadId: "cli-codex-1", event: "SessionStart", cwd: "/work/clix" });
  const alpha = await fakeClaude("cliclaude", livePid(), "idle");
  try {
    const env = { ...process.env } as Record<string, string>;
    delete env.CODEX_THREAD_ID;
    const run = (...args: string[]) => exec(process.execPath, [cli, ...args], { env, timeout: 30_000 }).then((r) => r.stdout);
    assert.match(await run("send", "opencode-clia", "hello opencode"), /to @opencode-clia \[[0-9a-f]+\] \(opencode\) as @/);
    assert.match(await run("send", "codex-clix", "hello codex"), /to @codex-clix \[[0-9a-f]+\] \(codex\) as @/);
    assert.match(await run("send", "cliclaude", "hello claude"), /to @cliclaude \[[0-9a-f]+\] \(claude\) as @/);
    const listed = await run("list");
    assert.match(listed, /^opencode-clia \[[0-9a-f]+\] +opencode /m);
    assert.match(listed, /^codex-clix \[[0-9a-f]+\] +codex /m);
    const json = JSON.parse(await run("list", "--json")) as Peer[];
    const byName = new Map(json.map((p) => [p.name, p]));
    assert.deepEqual([byName.get("opencode-clia")!.kind, byName.get("opencode-clia")!.agent], ["codex", "opencode"]);
    assert.deepEqual([byName.get("codex-clix")!.kind, "agent" in byName.get("codex-clix")!], ["codex", false]);
    assert.deepEqual([byName.get("cliclaude")!.kind, "agent" in byName.get("cliclaude")!], ["claude", false]);
  } finally {
    await closeServer(alpha.server);
  }
});

test("message_status and stats name the destination's agent", async () => {
  await start("hermes", "stat-1", "/work/stata");
  await broker.hook({ threadId: "stat-codex-1", event: "SessionStart", cwd: "/work/statx" });
  const me = await codexIdentity("stat-codex-1");
  const toAgent = await sendMessage(me, "hermes-stata", "status of an agent message", undefined, { urgency: "fyi" });
  const toCodex = await sendMessage(await agentIdentity("hermes", "stat-1", "/work/stata"), "codex-statx", "status of a codex message", undefined, { urgency: "fyi" });
  const agentStatus = formatMessageStatus(await messageStatus(me, toAgent.msgId));
  assert.match(agentStatus, /\(to @hermes-stata, hermes\)/);
  assert.doesNotMatch(agentStatus, /hermes-stata, codex/);
  assert.match(formatMessageStatus(await messageStatus(await agentIdentity("hermes", "stat-1", "/work/stata"), toCodex.msgId)), /\(to @codex-statx, codex\)/);
  const table = formatStats(await stats());
  assert.match(table, /^@hermes-stata \(hermes\): /m);
  assert.match(table, /^@codex-statx \(codex\): /m);
});

test("top shows the agent in its kind column and keeps the column aligned, the JSON snapshot keeps kind and adds agent, and a sender's agent label is not part of the last-message name", async () => {
  await start("opencode", "top-1", "/work/topa");
  await broker.hook({ threadId: "top-codex-1", event: "SessionStart", cwd: "/work/topx" });
  const sender = await agentIdentity("copilot", "top-2", "/work/topsender");
  await sendMessage(sender, "opencode-topa", "message for top", undefined, { urgency: "fyi" });
  const snap = topSnapshot(broker);
  const agent = snap.peers.find((p) => p.name === "opencode-topa")!;
  assert.deepEqual([agent.kind, agent.agent], ["codex", "opencode"]);
  const codex = snap.peers.find((p) => p.name === "codex-topx")!;
  assert.deepEqual([codex.kind, "agent" in codex], ["codex", false]);
  assert.equal(agent.lastMessage?.from, sender.name);
  const plain = renderTop(snap, { width: 130, color: false, now: snap.at });
  assert.match(plain, /^opencode-topa +opencode +\S+ /m);
  assert.match(plain, /^codex-topx +codex +\S+ /m);
  const header = plain.split("\n").find((l) => l.startsWith("PEER"))!;
  const row = plain.split("\n").find((l) => l.startsWith("opencode-topa"))!;
  assert.equal(header.indexOf("STATE"), row.search(/(idle|busy|waiting|unknown)/), "the state column starts where its header does");
});

test("a remote caller's list_peers and the phone app's list name the agent", () => {
  const peers: Peer[] = [
    { kind: "codex", agent: "cursor", name: "cursor-site", ref: "aaaaaa", socketPath: "/x/a.sock", status: "idle", cwd: "/work/site" },
    { kind: "codex", name: "codex-site", ref: "bbbbbb", socketPath: "/x/b.sock", status: "idle" },
    { kind: "claude", name: "ops", ref: "cccccc", socketPath: "/x/c.sock", status: "idle" },
  ];
  const text = formatVisible(peers, "private");
  assert.match(text, /^- cursor-site \[aaaaaa\] cursor, idle, \/work\/site$/m);
  assert.match(text, /^- codex-site \[bbbbbb\] codex, idle$/m);
  assert.match(text, /^- ops \[cccccc\] claude, idle$/m);
});

test("channel membership and a channel post name an agent's session by its agent", async () => {
  const cursorId = await start("cursor", "chan-1", "/work/chana");
  await broker.hook({ threadId: "chan-codex-1", event: "SessionStart", cwd: "/work/chanx" });
  const agentMe = await agentIdentity("cursor", "chan-1", "/work/chana");
  const codexMe = await codexIdentity("chan-codex-1");
  await subscribeTo(agentMe, "#labels");
  await subscribeTo(codexMe, "#labels");
  const listed = formatChannels(await listChannels(codexMe));
  assert.match(listed, /@cursor-chana \(cursor\)/);
  assert.match(listed, /@codex-chanx \(codex\) \(you\)/);
  assert.doesNotMatch(listed, /cursor-chana \(codex\)/);
  const posted = formatPost(await postToChannel(codexMe, "#labels", "channel hello", "fyi"));
  assert.match(posted, /- @cursor-chana \(cursor\): /);
  assert.ok(cursorId.startsWith("cursor_"));
});

test("an ask names the sessions it went to by their agent", async () => {
  await start("gemini", "ask-1", "/work/aska");
  await broker.hook({ threadId: "ask-codex-1", event: "SessionStart", cwd: "/work/askx" });
  const asker = await codexIdentity("ask-codex-1");
  const text = formatAsk(await askSessions(asker, { to: ["gemini-aska"], question: "anyone there?", timeoutSeconds: 1 }));
  assert.match(text, /No answer from @gemini-aska \(gemini\) within 1 s/);
});
