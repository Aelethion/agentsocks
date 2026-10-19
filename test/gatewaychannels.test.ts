import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { until, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { askSessions } from "../src/askclient.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress, messageContent, parseEnvelope } from "../src/envelope.ts";
import { meOfPeer } from "../src/gateway/gtools.ts";
import { gatewayState } from "../src/gateway/state.ts";
import { codexIdentity, type Me } from "../src/peers.ts";
import { partyOf, sendMessage } from "../src/send.ts";
import { topSnapshot } from "../src/top.ts";
import { fakeLocalApi, fakeServe, mcpClient, type FakeLocalApi, type FakeServe } from "./gatewaysupport.ts";

const broker = new Broker();
let api: FakeLocalApi;
let serve: FakeServe;
let client: Client;
let alpha: FakeClaude;
let beta: FakeClaude;
let codexA: Me;
let codexB: Me;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
  return { text: (r.content as { text: string }[]).map((c) => c.text).join("\n"), isError: r.isError === true };
};

const claudeParty = (c: FakeClaude) => ({ kind: "claude", name: c.name, addr: encodeAddress(c.socketPath), session: c.sessionId, mode: null });
const mayMessage = (...names: string[]) => broker.dispatch({ op: "gateway_may", peer: "hetzner-lab", mayMessage: names });
const subscribeLocal = (party: Record<string, unknown>, channel: string) => broker.dispatch({ op: "channel_subscribe", party, channel });
const bodiesOf = (c: FakeClaude): string[] => c.frames.map((f) => parseEnvelope(messageContent(f))?.body ?? "");
const remoteThread = (): string => gatewayState(broker.store).peerByName("hetzner-lab")!.thread_id;
const messagesTo = (threadId: string | undefined): number => Number((broker.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_thread = ?").get(threadId ?? "") as { n: number }).n);
const members = (channel: string): { member: string; kind: string; name: string }[] => broker.store.db.prepare("SELECT member, kind, name FROM channel_members WHERE channel = ? ORDER BY member").all(channel) as { member: string; kind: string; name: string }[];
const latestAsk = (): string | undefined => (broker.store.db.prepare("SELECT id FROM asks ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string } | undefined)?.id;
const nextAsk = (previous: string | undefined): Promise<string> => until(() => (latestAsk() !== previous ? latestAsk() : undefined));
const answerAs = (c: FakeClaude, askId: string, answer: string) => broker.dispatch({ op: "ask_answer", party: claudeParty(c), askId, answer });

before(async () => {
  api = await fakeLocalApi();
  process.env.TS_SOCKET = api.socketPath;
  api.machines.set("100.64.1.1", { name: "hetzner-lab", login: "sam@example.com", ip: "100.64.1.1" });
  await broker.start();
  alpha = await fakeClaude("alpha", livePid(), "idle");
  beta = await fakeClaude("beta", livePid(), "idle");
  codexA = await codexIdentity("codex-thread-gc1", "/work/gc-one");
  codexB = await codexIdentity("codex-thread-gc2", "/work/gc-two");
  const on = (await broker.dispatch({ op: "gateway_on", port: 0 })).result as { private: { port: number } };
  serve = await fakeServe(on.private.port, { login: "sam@example.com", ip: "100.64.1.1" });
  client = await mcpClient(serve.url);
  await call("list_peers");
});

after(async () => {
  await client.close();
  await serve.close();
  await closeServer(alpha.server);
  await closeServer(beta.server);
  await broker.stop();
  await api.close();
});

test("a tailnet peer subscribes and unsubscribes itself, and extra arguments cannot name another member", async () => {
  await mayMessage("*");
  await subscribeLocal(claudeParty(alpha), "gc-self");
  const r = await call("subscribe", { channel: "gc-self", session: alpha.sessionId, name: "alpha", member: alpha.sessionId, addr: encodeAddress(alpha.socketPath) });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Subscribed to #gc-self/);
  assert.deepEqual(
    members("gc-self").map((m) => [m.member, m.kind, m.name]),
    [
      [alpha.sessionId, "claude", "alpha"],
      [remoteThread(), "remote", "hetzner-lab"],
    ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
  );
  const gone = await call("unsubscribe", { channel: "gc-self" });
  assert.match(gone.text, /Unsubscribed from #gc-self/);
  assert.deepEqual(members("gc-self").map((m) => m.member), [alpha.sessionId], "the local member is still subscribed");
});

test("a tailnet peer sees in list_channels and in a subscribe result only the members it may message", async () => {
  await subscribeLocal(claudeParty(alpha), "gc-view");
  await subscribeLocal(claudeParty(beta), "gc-view");
  await subscribeLocal(partyOf(codexA), "gc-view");
  await subscribeLocal(claudeParty(beta), "gc-beta-only");
  await mayMessage("alpha");
  try {
    const listed = await call("list_channels");
    assert.match(listed.text, /#gc-view: @alpha/);
    assert.doesNotMatch(listed.text, /beta|codex-gc-one/);
    assert.doesNotMatch(listed.text, /gc-beta-only/, "a channel with no one it may message is not shown");
    const joined = await call("subscribe", { channel: "gc-view" });
    assert.match(joined.text, /2 subscribers: @alpha, @hetzner-lab \(you\)/);
    assert.doesNotMatch(joined.text, /beta|codex-gc-one/);
    await call("unsubscribe", { channel: "gc-view" });
  } finally {
    await mayMessage("*");
  }
});

test("a post to a channel reaches the members a restricted tailnet peer may message, and nothing names the others", async () => {
  await subscribeLocal(claudeParty(alpha), "gc-post");
  await subscribeLocal(claudeParty(beta), "gc-post");
  await subscribeLocal(partyOf(codexA), "gc-post");
  await mayMessage("alpha");
  try {
    const sent = await call("send_message", { to: "#gc-post", message: "deploy finished on hetzner-lab" });
    assert.equal(sent.isError, false, sent.text);
    assert.match(sent.text, /@alpha/);
    assert.doesNotMatch(sent.text, /beta|codex-gc-one/);
    await until(() => bodiesOf(alpha).includes("[#gc-post] deploy finished on hetzner-lab"));
    assert.ok(!bodiesOf(beta).some((b) => b.includes("deploy finished on hetzner-lab")), "beta is outside the list");
    assert.equal(messagesTo(codexA.session), 0, "the Codex subscriber is outside the list");
  } finally {
    await mayMessage("*");
  }
});

test("a tailnet peer whose list is everyone posts to every subscriber, and the post is routed per delivery as a remote sender", async () => {
  await subscribeLocal(claudeParty(beta), "gc-wide");
  await subscribeLocal(partyOf(codexB), "gc-wide");
  const sent = await call("send_message", { to: "#gc-wide", message: "wide post" });
  assert.equal(sent.isError, false, sent.text);
  assert.match(sent.text, /@beta/);
  assert.match(sent.text, /codex-gc-two/);
  const frame = await until(() => beta.frames.find((f) => parseEnvelope(messageContent(f))?.body === "[#gc-wide] wide post"));
  const env = parseEnvelope(messageContent(frame))!;
  assert.equal(env.fromName, "hetzner-lab");
  assert.equal(env.fromMode, undefined);
});

test("a tailnet peer cannot broadcast: not with the broadcast tool, not by posting to #all, and not by asking #all", async () => {
  const before = alpha.frames.length + beta.frames.length;
  const post = await call("send_message", { to: "#all", message: "to everyone" });
  assert.equal(post.isError, true);
  assert.match(post.text, /#all|broadcast/);
  const ask = await call("ask", { to: ["#all"], question: "who is there?", timeout_seconds: 2 });
  assert.equal(ask.isError, true);
  assert.match(ask.text, /#all|broadcast/);
  const tool = await call("broadcast", { message: "to everyone" });
  assert.equal(tool.isError, true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alpha.frames.length + beta.frames.length, before);
});

test("a broadcast from a local session reaches local sessions and no remote peer", async () => {
  const unread = messagesTo(remoteThread());
  const sent = await broker.dispatch({ op: "channel_send", from: partyOf(codexA), channel: "#all", body: "fleet notice", urgency: "normal" });
  const post = sent.result as { deliveries: { name: string; kind: string }[] };
  assert.ok(post.deliveries.some((d) => d.name === "alpha"));
  assert.ok(post.deliveries.every((d) => d.kind !== "remote" && d.name !== "hetzner-lab"), JSON.stringify(post.deliveries));
  await until(() => bodiesOf(alpha).includes("[#all] fleet notice"));
  assert.equal(messagesTo(remoteThread()), unread, "nothing reached the tailnet peer's inbox");
});

test("a local post to a channel a tailnet peer subscribed to reaches its inbox, from the sender and without a reply address", async () => {
  await call("subscribe", { channel: "gc-inbound" });
  await broker.dispatch({ op: "channel_send", from: partyOf(codexA), channel: "#gc-inbound", body: "inbound for the phone", urgency: "normal" });
  let text = "";
  for (let i = 0; i < 100 && !text.includes("inbound for the phone"); i++) {
    text = (await call("read_inbox")).text;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.match(text, /\[#gc-inbound\] inbound for the phone/);
  assert.match(text, /from="@codex-gc-one/);
  assert.doesNotMatch(text, /uds:|reply-to/);
  await call("unsubscribe", { channel: "gc-inbound" });
});

test("a tailnet peer asks the sessions it may message, gets their answers together, and cannot ask one outside its list", async () => {
  await mayMessage("alpha");
  try {
    const previous = latestAsk();
    const pending = call("ask", { to: ["alpha"], question: "which branch is live?", timeout_seconds: 20 });
    const id = await nextAsk(previous);
    await until(() => bodiesOf(alpha).find((b) => b.includes(id)));
    await answerAs(alpha, id, "main");
    const done = await pending;
    assert.equal(done.isError, false, done.text);
    assert.match(done.text, new RegExp(`Ask ${id}: 1 session asked, 1 answered`));
    assert.match(done.text, /alpha .*answered after/);
    assert.match(done.text, /main/);

    const mark = latestAsk();
    const outside = await call("ask", { to: ["beta"], question: "can you hear me?", timeout_seconds: 2 });
    assert.equal(outside.isError, true);
    assert.match(outside.text, /no running session named "beta"/);
    assert.equal(latestAsk(), mark, "no ask was stored");
    assert.ok(!bodiesOf(beta).some((b) => b.includes("can you hear me?")));
  } finally {
    await mayMessage("*");
  }
});

test("an ask from a tailnet peer waits no longer than wait_for_message may", async () => {
  const previous = latestAsk();
  const pending = call("ask", { to: ["alpha"], question: "how long do you wait?", timeout_seconds: 280 });
  const id = await nextAsk(previous);
  const row = broker.store.db.prepare("SELECT created_at, expires_at FROM asks WHERE id = ?").get(id) as { created_at: number; expires_at: number };
  assert.equal(row.expires_at - row.created_at, 120_000);
  await until(() => bodiesOf(alpha).find((b) => b.includes(id)));
  await answerAs(alpha, id, "ok");
  assert.equal((await pending).isError, false);
});

test("a tailnet peer cannot ask for a pick, which would send the replies to the owner's classifier", async () => {
  const mark = latestAsk();
  const r = await call("ask", { to: ["alpha"], question: "which is better?", pick: "best", timeout_seconds: 2 });
  assert.equal(r.isError, true);
  assert.match(r.text, /pick is not available to a remote peer/);
  assert.equal(latestAsk(), mark, "no ask was stored");
  assert.ok(!bodiesOf(alpha).some((b) => b.includes("which is better?")));
});

test("asking a channel from a restricted tailnet peer asks only the members it may message", async () => {
  await subscribeLocal(claudeParty(alpha), "gc-askers");
  await subscribeLocal(claudeParty(beta), "gc-askers");
  await mayMessage("alpha");
  try {
    const previous = latestAsk();
    const pending = call("ask", { to: ["#gc-askers"], question: "who owns the release?", timeout_seconds: 20 });
    const id = await nextAsk(previous);
    await until(() => bodiesOf(alpha).find((b) => b.includes(id)));
    await answerAs(alpha, id, "me");
    const done = await pending;
    assert.match(done.text, /1 session asked, 1 answered/);
    assert.doesNotMatch(done.text, /beta/);
    assert.ok(!bodiesOf(beta).some((b) => b.includes("who owns the release?")));
  } finally {
    await mayMessage("*");
  }
});

test("a tailnet peer answers an ask it was sent, and not when its list excludes the asker", async () => {
  const earlier = latestAsk();
  const first = askSessions(codexA, { to: ["hetzner-lab"], question: "are you there?", timeoutSeconds: 20 });
  const id = await nextAsk(earlier);
  let inbox = "";
  for (let i = 0; i < 100 && !inbox.includes(id); i++) {
    inbox = (await call("read_inbox")).text;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.match(inbox, new RegExp(id));
  const answered = await call("answer", { ask_id: id, answer: "yes, on the tailnet" });
  assert.equal(answered.isError, false, answered.text);
  assert.match((await first).ask.targets[0]!.answer ?? "", /yes, on the tailnet/);

  await mayMessage("alpha");
  try {
    const previous = latestAsk();
    const second = askSessions(codexA, { to: ["hetzner-lab"], question: "and now?", timeoutSeconds: 3 });
    const other = await nextAsk(previous);
    let text = "";
    for (let i = 0; i < 100 && !text.includes(other); i++) {
      text = (await call("read_inbox")).text;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const refused = await call("answer", { ask_id: other, answer: "should not count" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /may not message/);
    assert.equal((await second).ask.targets[0]!.state, "asked", "the ask has no answer");
  } finally {
    await mayMessage("*");
  }
});

test("a tailnet peer rates a message it was sent, and cannot rate one that went to another session", async () => {
  const mine = await sendMessage(codexA, "hetzner-lab", "please look at the failing job");
  let seen = "";
  for (let i = 0; i < 100 && !seen.includes("failing job"); i++) {
    seen = (await call("read_inbox")).text;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const rated = await call("rate_message", { rating: "could-wait", message_id: mine.msgId });
  assert.equal(rated.isError, false, rated.text);
  assert.match(rated.text, /Rated the message from @codex-gc-one( \(codex\))? as could-wait/);
  const stored = broker.store.db.prepare("SELECT receiver_name, receiver_kind, rating FROM labels WHERE msg_id = ?").all(mine.msgId) as { receiver_name: string; receiver_kind: string; rating: string }[];
  assert.deepEqual(stored.map((l) => ({ ...l })), [{ receiver_name: "hetzner-lab", receiver_kind: "remote", rating: "could-wait" }]);

  const theirs = await sendMessage(codexA, "alpha", "alpha only", undefined, { urgency: "urgent" });
  await until(() => bodiesOf(alpha).includes("alpha only"));
  const refused = await call("rate_message", { rating: "noise", message_id: theirs.msgId });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /was delivered to you/);
  const none = broker.store.db.prepare("SELECT COUNT(*) AS n FROM labels WHERE msg_id = ?").get(theirs.msgId) as { n: number };
  assert.equal(Number(none.n), 0);
});

test("top lists a tailnet peer as remote, not as a Codex session", () => {
  const peer = topSnapshot(broker).peers.find((p) => p.name === "hetzner-lab");
  assert.ok(peer, "the tailnet peer is listed");
  assert.equal(peer.kind, "remote");
});

test("a public peer can answer an ask it was sent but cannot post to a channel", async () => {
  const pub = (await broker.dispatch({ op: "gateway_public", via: "funnel", port: 0 })).result as { public: { port: number } };
  const made = (await broker.dispatch({ op: "gateway_token_add", name: "gc-grok", mayMessage: ["*"] })).result as { token: string };
  const grok = await mcpClient(`http://127.0.0.1:${pub.public.port}`, { Authorization: `Bearer ${made.token}` });
  const callGrok = async (name: string, args: Record<string, unknown>) => {
    const r = await grok.callTool({ name, arguments: args });
    return { text: (r.content as { text: string }[]).map((c) => c.text).join("\n"), isError: r.isError === true };
  };
  try {
    await subscribeLocal(claudeParty(alpha), "gc-public");
    const post = await callGrok("send_message", { to: "#gc-public", message: "from a token" });
    assert.equal(post.isError, true);
    assert.match(post.text, /channels are not available/);
    assert.ok(!bodiesOf(alpha).some((b) => b.includes("from a token")));

    const asking = askSessions(codexA, { to: ["gc-grok"], question: "ping?", timeoutSeconds: 20 });
    const id = await nextAsk(latestAsk());
    let inbox = "";
    for (let i = 0; i < 100 && !inbox.includes(id); i++) {
      inbox = (await callGrok("read_inbox", {})).text;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const answered = await callGrok("answer", { ask_id: id, answer: "pong" });
    assert.equal(answered.isError, false, answered.text);
    assert.equal((await asking).ask.targets[0]!.answer, "pong");
  } finally {
    await grok.close();
  }
});

test("a channel member that was renamed off a restricted tailnet peer's list is no longer reached through the channel, and the new name is not shown", async () => {
  const renamed = await codexIdentity("codex-thread-gc3", "/work/gc-ren");
  await subscribeLocal(partyOf(renamed), "gc-ren");
  await mayMessage(renamed.name);
  try {
    const first = await call("send_message", { to: "#gc-ren", message: "before the rename" });
    assert.match(first.text, new RegExp(renamed.name));
    assert.equal(messagesTo(renamed.session), 1);
    await broker.dispatch({ op: "set_name", threadId: renamed.session, name: "payroll" });
    const second = await call("send_message", { to: "#gc-ren", message: "after the rename" });
    assert.doesNotMatch(second.text, /payroll/);
    assert.equal(messagesTo(renamed.session), 1, "nothing was delivered after the rename");
    assert.doesNotMatch((await call("list_channels")).text, /gc-ren/);
    const asked = await call("ask", { to: ["#gc-ren"], question: "still there?", timeout_seconds: 2 });
    assert.equal(asked.isError, true);
    assert.doesNotMatch(asked.text, /payroll/);
  } finally {
    await mayMessage("*");
  }
});

test("route_send checks the receiver's current name against a remote sender's list, whatever name the request carries", async () => {
  const renamed = await codexIdentity("codex-thread-gc5", "/work/gc-old");
  const oldName = renamed.name;
  await mayMessage(oldName);
  try {
    await broker.dispatch({ op: "set_name", threadId: renamed.session, name: "payroll-two" });
    const from = partyOf(meOfPeer(broker, gatewayState(broker.store).peerByName("hetzner-lab")!));
    const to = { kind: "codex", addr: encodeAddress(renamed.socketPath!), name: oldName, threadId: renamed.session };
    await assert.rejects(broker.dispatch({ op: "route_send", msgId: "m-gc-rename", from, to, body: "under the old name", urgency: "normal" }), /may not message/);
    assert.equal(messagesTo(renamed.session), 0);
  } finally {
    await mayMessage("*");
  }
});

test("a tailnet peer cannot answer an ask whose asker has since been renamed off its list", async () => {
  const asker = await codexIdentity("codex-thread-gc4", "/work/gc-asker");
  await mayMessage(asker.name);
  try {
    const previous = latestAsk();
    const asking = askSessions(asker, { to: ["hetzner-lab"], question: "rename me first", timeoutSeconds: 3 });
    const id = await nextAsk(previous);
    let inbox = "";
    for (let i = 0; i < 100 && !inbox.includes(id); i++) {
      inbox = (await call("read_inbox")).text;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await broker.dispatch({ op: "set_name", threadId: asker.session, name: "payroll-three" });
    const refused = await call("answer", { ask_id: id, answer: "too late" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /may not message/);
    assert.equal((await asking).ask.targets[0]!.state, "asked");
  } finally {
    await mayMessage("*");
  }
});

test("a switched-off remote peer is not a live channel member: a post does not try it and top does not list it", async () => {
  const made = (await broker.dispatch({ op: "gateway_token_add", name: "gc-sleeper", mayMessage: [] })).result as { id: string };
  const sleeper = gatewayState(broker.store).peerByName("gc-sleeper")!;
  await subscribeLocal(partyOf(meOfPeer(broker, sleeper)), "gc-disabled");
  const awake = await broker.dispatch({ op: "channel_send", from: partyOf(codexA), channel: "#gc-disabled", body: "while awake", urgency: "normal" });
  assert.equal((awake.result as { deliveries: { name: string }[] }).deliveries.some((d) => d.name === "gc-sleeper (remote)"), true, "channel deliveries use the marked from-name (G6)");
  assert.ok(topSnapshot(broker).peers.some((p) => p.name === "gc-sleeper"));
  const unread = messagesTo(sleeper.thread_id);
  await broker.dispatch({ op: "gateway_token_revoke", id: made.id });
  const asleep = await broker.dispatch({ op: "channel_send", from: partyOf(codexA), channel: "#gc-disabled", body: "while switched off", urgency: "normal" });
  const post = asleep.result as { deliveries: unknown[]; notRunning: { count: number } };
  assert.equal(post.deliveries.length, 0);
  assert.equal(post.notRunning.count, 1);
  assert.equal(messagesTo(sleeper.thread_id), unread);
  assert.ok(!topSnapshot(broker).peers.some((p) => p.name.startsWith("gc-sleeper")));
});

test("a tailnet peer cannot rate a message that was surfaced to another Codex session", async () => {
  const sent = await sendMessage(codexA, codexB.name, "meant for codex b only");
  const reply = broker.read(codexB.session!);
  reply.commit?.();
  const refused = await call("rate_message", { rating: "noise", message_id: sent.msgId });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /was delivered to you/);
  const labels = broker.store.db.prepare("SELECT COUNT(*) AS n FROM labels WHERE msg_id = ?").get(sent.msgId) as { n: number };
  assert.equal(Number(labels.n), 0);
});

test("ask refuses a socket address as a recipient and does not echo it", async () => {
  const mark = latestAsk();
  const r = await call("ask", { to: [`uds:${alpha.socketPath}`], question: "straight to the socket?", timeout_seconds: 2 });
  assert.equal(r.isError, true);
  assert.match(r.text, /name the sessions as list_peers shows them/);
  assert.doesNotMatch(r.text, new RegExp(alpha.socketPath));
  assert.equal(latestAsk(), mark);
  assert.ok(!bodiesOf(alpha).some((b) => b.includes("straight to the socket?")));
});

test("top keeps a tailnet peer that registered more than a day ago", () => {
  broker.store.updateThread(remoteThread(), { last_seen: Date.now() - 25 * 3_600_000 });
  assert.ok(topSnapshot(broker).peers.some((p) => p.name === "hetzner-lab"));
});
