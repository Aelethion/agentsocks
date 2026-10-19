import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { wakeLog, sleep, until, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer, postLines } from "../src/ccsocks.ts";
import { brokerCall } from "../src/client.ts";
import { buildEnvelope, decodeAddress, messageContent, parseEnvelope } from "../src/envelope.ts";
import { listPeers, type Me } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";
import { ensurePeer } from "../src/gateway/remote.ts";
import { gatewayState } from "../src/gateway/state.ts";
import { codexIdentity } from "../src/peers.ts";

const broker = new Broker();
let alpha: FakeClaude;
let beta: FakeClaude;

before(async () => {
  await broker.start();
  alpha = await fakeClaude("alpha", livePid(), "idle");
  beta = await fakeClaude("beta", livePid(), "idle");
});

after(async () => {
  await closeServer(alpha.server);
  await closeServer(beta.server);
  await broker.stop();
});

async function remote(id: string, name: string, over: { may?: string[]; machine?: string } = {}): Promise<Me> {
  const peer = await ensurePeer(broker, { id, name, via: "tailnet", machine: over.machine ?? "iphone-14", login: "sam@example.com", mayMessage: over.may ?? ["*"] });
  const info = (await brokerCall<{ threadId: string; socketPath: string }[]>("list_remote_peers")).find((p) => p.threadId === peer.thread_id)!;
  return { kind: "remote", name: peer.name, socketPath: info.socketPath, session: peer.thread_id };
}

const wakes = () => (existsSync(wakeLog) ? readFileSync(wakeLog, "utf8") : "");

test("a remote peer is listed as kind remote with how it connected and from which machine, and never as a Codex thread", async () => {
  const me = await remote("tailnet:node-1:app", "sam (phone)");
  const peers = await listPeers({ includeUnconnected: false });
  const mine = peers.find((p) => p.name === "sam (phone)")!;
  assert.deepEqual([mine.kind, mine.via, mine.machine, mine.session], ["remote", "tailnet", "iphone-14", me.session]);
  assert.match(mine.ref, /^[0-9a-f]{6,}$/);
  const threads = await brokerCall<{ threadId: string }[]>("list_threads");
  assert.ok(!threads.some((t) => t.threadId === me.session), "list_threads is the Codex view and stays without remote peers");
});

test("a local agent messages a remote peer by name or by the name without its note, and the remote reads it framed as a peer message with no local socket path in it", async () => {
  const me = await remote("tailnet:node-1:app", "sam (phone)");
  const codex = await codexIdentity("codex-sender-1", "/work/sender");
  const sent = await sendMessage(codex, "sam", "build is green");
  assert.equal(sent.to.kind, "remote");
  const reply = broker.read(me.session!, "remote");
  const text = (reply.result as { text: string }).text;
  assert.match(text, /build is green/);
  assert.match(text, /from="@codex-sender/);
  assert.doesNotMatch(text, /reply-to=|uds:|\.sock/);
  assert.match(text, /send_message tool with to set to the sender's name/);
  reply.commit?.();
  assert.equal((broker.read(me.session!, "remote").result as { count: number }).count, 0, "read once, then it is gone");
});

test("a message to a remote peer never starts a Codex wake", async () => {
  const me = await remote("tailnet:node-1:app", "sam (phone)");
  const before = wakes();
  const codex = await codexIdentity("codex-sender-2", "/work/sender2");
  await sendMessage(codex, "sam (phone)", "are you there");
  await broker.wake(me.session!);
  await sleep(1700);
  assert.equal(wakes(), before);
  broker.read(me.session!, "remote").commit?.();
});

test("a remote peer messaging a Claude session arrives with its name, no permission mode and an address Claude can answer natively", async () => {
  const me = await remote("tailnet:node-2:app", "ops-laptop", { machine: "ops-laptop" });
  const sent = await sendMessage(me, "alpha", "deploy finished");
  assert.equal(sent.to.kind, "claude");
  const frame = await until(() => alpha.frames.at(-1));
  const env = parseEnvelope(messageContent(frame))!;
  assert.equal(env.fromName, "ops-laptop");
  assert.equal(env.fromMode, undefined, "a remote peer asserts no permission mode, so a bypassing receiver holds it for approval");
  assert.equal(env.body, "deploy finished");
  const replyTo = decodeAddress(env.from!)!;
  const answer = buildEnvelope({ from: "uds:/claude/alpha", fromName: "alpha", fromSession: alpha.sessionId, body: "thanks, noted" });
  await postLines(replyTo, [JSON.stringify({ type: "user", message: { role: "user", content: answer }, priority: "next", from: "uds:/claude/alpha", msg_id: "native-reply-1" })]);
  const text = await until(() => {
    const t = (broker.read(me.session!, "remote").result as { text: string }).text;
    return t.includes("thanks, noted") ? t : undefined;
  });
  assert.match(text, /from="@alpha/);
});

test("a remote peer may message only the names its list allows, and a refused send reaches no one", async () => {
  const me = await remote("token:t1", "grok", { may: ["alpha"] });
  const before = beta.frames.length;
  await sendMessage(me, "alpha", "allowed question");
  await until(() => alpha.frames.some((f) => parseEnvelope(messageContent(f))?.body === "allowed question"));
  await assert.rejects(sendMessage(me, "beta", "not allowed"), /grok may not message beta/);
  await sleep(100);
  assert.equal(beta.frames.length, before);
});

test("a remote peer with an empty list may message no one, and one that is switched off may not message at all", async () => {
  const quiet = await remote("token:t2", "chatgpt", { may: [] });
  await assert.rejects(sendMessage(quiet, "alpha", "hello"), /chatgpt may not message alpha/);
  const state = gatewayState(broker.store);
  const peer = state.getPeer("token:t2")!;
  state.updatePeer(peer.id, { may_message: JSON.stringify(["*"]), disabled: 1 });
  await assert.rejects(sendMessage(quiet, "alpha", "hello"), /chatgpt is switched off/);
  assert.ok(!(await listPeers({})).some((p) => p.name === "chatgpt"), "a switched-off peer is not listed");
});

test("a remote peer that has not connected for a day is still listed and still reachable, marked offline", async () => {
  const me = await remote("token:t3", "claude-web");
  gatewayState(broker.store).updatePeer("token:t3", { last_seen: Date.now() - 2 * 86_400_000 });
  const mine = (await listPeers({})).find((p) => p.name === "claude-web")!;
  assert.equal(mine.status, "offline");
  const codex = await codexIdentity("codex-sender-3", "/work/sender3");
  const sent = await sendMessage(codex, "claude-web", "still there?");
  assert.ok(sent.delivered);
  broker.read(me.session!, "remote").commit?.();
});

test("the list of names a remote peer may message can be changed after it was made, and * means every session", async () => {
  const me = await remote("token:t4", "late-list", { may: [] });
  await assert.rejects(sendMessage(me, "alpha", "first"), /may not message alpha/);
  const set = (await brokerCall<{ mayMessage: string[] }>("gateway_may", { peer: "late-list", mayMessage: ["alpha"] })).mayMessage;
  assert.deepEqual(set, ["alpha"]);
  await sendMessage(me, "alpha", "second, after the list changed");
  await until(() => alpha.frames.find((f) => parseEnvelope(messageContent(f))?.body === "second, after the list changed"));
  await assert.rejects(sendMessage(me, "beta", "third"), /may not message beta/);
  await brokerCall("gateway_may", { peer: "late-list", mayMessage: ["*"] });
  await sendMessage(me, "beta", "fourth, to everyone");
  await until(() => beta.frames.find((f) => parseEnvelope(messageContent(f))?.body === "fourth, to everyone"));
  await assert.rejects(brokerCall("gateway_may", { peer: "nobody-by-that-name", mayMessage: [] }), /no remote peer named nobody-by-that-name/);
});

test("peer_status names a remote peer as remote, not as a Codex session", async () => {
  const me = await remote("token:t5", "status-peer", { may: ["*"] });
  const status = (await brokerCall<{ peer: { name: string; kind: string } }>("peer_status", { to: { kind: "codex", addr: `uds:${me.socketPath}`, name: "status-peer", threadId: me.session } }));
  assert.deepEqual([status.peer.name, status.peer.kind], ["status-peer", "remote"]);
});
