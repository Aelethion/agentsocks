import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { sleep, until, wakeLog } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { agentIdentity, codexIdentity, listPeers, resolvePeer, ResolveError, RESOLVABLE, type Peer } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";
import { threadIdFor, type AgentSpec } from "../src/agents/index.ts";
import { ensurePeer } from "../src/gateway/remote.ts";
import { gatewayState } from "../src/gateway/state.ts";
import { formatPost } from "../src/channels.ts";
import { postToChannel, subscribeTo } from "../src/channelclient.ts";
import { fakeLocalApi, fakeServe, mcpClient, type FakeLocalApi, type FakeServe } from "./gatewaysupport.ts";

const woken: { threadId: string; line: string }[] = [];

const inertInstaller: AgentSpec["installer"] = { detect: () => false, install: () => {}, uninstall: () => {}, status: () => ({ state: "not installed", detail: [] }) };
const opencode: AgentSpec = {
  id: "opencode",
  live: "untested",
  hook: async () => undefined,
  wake: async ({ thread, line }) => {
    woken.push({ threadId: thread.thread_id, line });
    return { ok: true };
  },
  installer: inertInstaller,
};
const hermes: AgentSpec = {
  id: "hermes",
  live: "untested",
  hook: async () => undefined,
  wake: async ({ thread, line }) => {
    woken.push({ threadId: thread.thread_id, line });
    return { ok: true };
  },
  installer: inertInstaller,
};
const cursor: AgentSpec = { id: "cursor", live: "untested", hook: async () => undefined, installer: inertInstaller };

const broker = new Broker({ ttyScan: () => [], agents: [opencode, hermes, cursor] });
let api: FakeLocalApi;
let serve: FakeServe;
let tailnet: Client;

const codexQueues = (): number => (existsSync(wakeLog) ? readFileSync(wakeLog, "utf8").split("\n").filter((l) => l.startsWith("queue")).length : 0);
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await tailnet.callTool({ name, arguments: args });
  return { text: (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n"), isError: r.isError === true };
};
const remotePeer = async (): Promise<Peer> => (await listPeers({})).find((p) => p.kind === "remote" && p.name === "hetzner-lab")!;

before(async () => {
  api = await fakeLocalApi();
  process.env.TS_SOCKET = api.socketPath;
  api.machines.set("100.64.1.1", { name: "hetzner-lab", login: "sam@example.com", ip: "100.64.1.1" });
  await broker.start();
  const on = (await broker.dispatch({ op: "gateway_on", port: 0 })).result as { private: { port: number } };
  serve = await fakeServe(on.private.port, { login: "sam@example.com", ip: "100.64.1.1" });
  tailnet = await mcpClient(serve.url);
  await call("list_peers");
});

after(async () => {
  await tailnet.close();
  await serve.close();
  await broker.stop();
  await api.close();
});

async function agentSession(agent: "opencode" | "hermes" | "cursor", raw: string, cwd: string): Promise<string> {
  const threadId = threadIdFor(agent, raw)!;
  await broker.hook({ threadId, agent, event: "SessionStart", cwd });
  await broker.hook({ threadId, agent, event: "Stop" });
  return threadId;
}

test("B x C: a remote peer is listed as remote with how it connected and no agent, a local agent session as codex with its agent and no gateway fields, and a Codex session as it always was", async () => {
  await agentSession("opencode", "list-1", "/work/listed");
  await broker.hook({ threadId: "bxc-codex-list", event: "SessionStart", cwd: "/work/bxclisted" });
  const peers = JSON.parse(JSON.stringify(await listPeers({ includeStale: true, includeSubagents: true }))) as Record<string, unknown>[];
  const remote = peers.find((p) => p.kind === "remote" && p.name === "hetzner-lab")!;
  const agent = peers.find((p) => p.name === "opencode-listed")!;
  const codex = peers.find((p) => p.name === "codex-bxclisted")!;
  assert.ok(remote && agent && codex);
  assert.deepEqual([remote.via, remote.machine, "agent" in remote], ["tailnet", "hetzner-lab", false]);
  assert.deepEqual([agent.kind, agent.agent, "via" in agent, "machine" in agent], ["codex", "opencode", false, false]);
  assert.deepEqual([codex.kind, "agent" in codex, "via" in codex], ["codex", false, false]);
});

test("B x C: a remote caller's list_peers labels a local agent session by its agent, and a send to it says so", async () => {
  await agentSession("hermes", "tail-1", "/work/tailed");
  const listed = await call("list_peers");
  assert.match(listed.text, /^- hermes-tailed \[[0-9a-f]{6,}\] hermes, /m);
  const sent = await call("send_message", { to: "hermes-tailed", message: "a note from the phone" });
  assert.equal(sent.isError, false);
  assert.match(sent.text, /Sent to @hermes-tailed \[[0-9a-f]{6,}\] \(hermes\), message id /);
});

test("B x C: a message from a remote peer wakes a wakeable agent through its own wake and never through codex queue, with a line that names a remote peer and carries none of its text", async () => {
  const id = await agentSession("opencode", "wake-in", "/work/wakein");
  woken.length = 0;
  const queuesBefore = codexQueues();
  const sent = await call("send_message", { to: "opencode-wakein", message: "SECRET-TEXT-FROM-REMOTE" });
  assert.equal(sent.isError, false);
  const got = await until(() => woken.find((w) => w.threadId === id), 6000);
  assert.equal(got.line, "📨 agentsocks: new message from a remote peer. Read it with read_inbox.");
  assert.doesNotMatch(got.line, /SECRET/);
  assert.equal(codexQueues(), queuesBefore);
  assert.match(broker.take(id).text, /SECRET-TEXT-FROM-REMOTE/);
});

test("B x C: a message to a remote peer from a Codex session and from each agent never starts a Codex wake or an agent wake, even when the remote's thread row has been relabelled as an agent", async () => {
  const peer = await remotePeer();
  const remoteThread = peer.session!;
  const senders = [
    await codexIdentity("bxc-codex-send", "/work/bxcsend"),
    await agentIdentity("opencode", "send-oc", "/work/sendoc"),
    await agentIdentity("hermes", "send-he", "/work/sendhe"),
    await agentIdentity("cursor", "send-cu", "/work/sendcu"),
  ];
  woken.length = 0;
  const queuesBefore = codexQueues();
  for (const forced of ["codex", "opencode", "hermes"]) {
    broker.store.updateThread(remoteThread, { agent: forced });
    for (const sender of senders) await sendMessage(sender, "hetzner-lab", `to the remote from ${sender.name} while row says ${forced}`);
    await broker.wake(remoteThread, Date.now() + 10_000);
    await broker.runSweep();
    await sleep(1700);
    assert.deepEqual(woken.filter((w) => w.threadId === remoteThread), [], `no OpenCode or Hermes wake ran for the remote peer whose row says ${forced}`);
    assert.equal(codexQueues(), queuesBefore, `codex queue never ran for the remote peer whose row says ${forced}`);
  }
  broker.store.updateThread(remoteThread, { agent: "codex" });
  assert.equal(broker.store.getThread(remoteThread)!.pending_wake_at, null);
  await call("read_inbox");
});

test("B x C: the thread of a remote peer is never relabelled as an agent by a register call that names an agent, and a peer whose name looks like an agent's inbox cannot take an agent's thread id", async () => {
  const peer = await remotePeer();
  const remoteThread = peer.session!;
  await broker.register(remoteThread, { agent: "cursor" });
  assert.equal(broker.store.getThread(remoteThread)!.agent, "codex");
  assert.equal(broker.describe(broker.store.getThread(remoteThread)!).agent, "codex");
  const lookalike = await ensurePeer(broker, { id: "token:agent-lookalike", name: "cursor_lookalike", via: "token", mayMessage: ["*"] });
  assert.match(lookalike.thread_id, /^r-[0-9a-f]{24}$/);
  assert.equal(broker.store.getThread(lookalike.thread_id)!.agent, "codex");
  assert.equal(gatewayState(broker.store).peerByThread(lookalike.thread_id)!.name, "cursor_lookalike");
});

test("B x C: a remote peer and a local agent session with one name are never confused: a send by name is refused with both labelled, and by ref each message reaches only its own inbox", async () => {
  const agentThread = await agentSession("cursor", "clash-1", "/work/clash");
  await ensurePeer(broker, { id: "token:clash", name: "cursor-clash", via: "token", machine: "ci-box", mayMessage: ["*"] });
  const sender = await codexIdentity("bxc-codex-clash", "/work/bxcclash");
  const peers = await listPeers(RESOLVABLE);
  const remote = peers.find((p) => p.kind === "remote" && p.name === "cursor-clash")!;
  const local = peers.find((p) => p.session === agentThread)!;
  assert.notEqual(remote.ref, local.ref);
  assert.throws(
    () => resolvePeer(peers, "cursor-clash", sender),
    (err: unknown) => {
      assert.ok(err instanceof ResolveError);
      assert.match(err.message, /matches 2 sessions/);
      assert.match(err.message, new RegExp(`cursor-clash \\[${remote.ref}\\] \\(remote\\)`));
      assert.match(err.message, new RegExp(`cursor-clash \\[${local.ref}\\] \\(cursor\\)`));
      return true;
    },
  );
  await sendMessage(sender, local.ref, "for the cursor session only");
  await sendMessage(sender, remote.ref, "for the remote peer only");
  assert.match(broker.take(agentThread).text, /for the cursor session only/);
  const remoteInbox = broker.take(remote.session!).text;
  assert.match(remoteInbox, /for the remote peer only/);
  assert.doesNotMatch(remoteInbox, /for the cursor session only/);
  assert.equal(broker.take(agentThread).count, 0);
});

test("B x C: a channel with a remote peer and an agent session among its members posts to each, and the post names one by remote and the other by its agent", async () => {
  const agentThread = await agentSession("cursor", "chan-bxc", "/work/chanbxc");
  const joined = await call("subscribe", { channel: "bxc" });
  assert.equal(joined.isError, false);
  const member = await agentIdentity("cursor", "chan-bxc", "/work/chanbxc");
  await subscribeTo(member, "#bxc");
  await broker.hook({ threadId: "bxc-codex-poster", event: "SessionStart", cwd: "/work/bxcposter" });
  const poster = await codexIdentity("bxc-codex-poster");
  const text = formatPost(await postToChannel(poster, "#bxc", "channel note", "fyi"));
  assert.match(text, /- @hetzner-lab \(remote\): /);
  assert.match(text, /- @cursor-chanbxc \(cursor\): /);
  assert.match(broker.take(agentThread).text, /\[#bxc\] channel note/);
  assert.match((await call("read_inbox")).text, /\[#bxc\] channel note/);
});
