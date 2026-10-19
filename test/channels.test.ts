import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { until, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { brokerCall } from "../src/client.ts";
import { messageContent, parseEnvelope } from "../src/envelope.ts";
import { codexIdentity, type Me } from "../src/peers.ts";
import { listChannels, postToChannel, subscribeTo, unsubscribeFrom } from "../src/channelclient.ts";
import { ChannelService, formatChannels, formatPost, parseChannel } from "../src/channels.ts";
import type { OutboxRow } from "../src/store.ts";

const broker = new Broker({ wakeEnabled: false });
const outboxTo = (name: string): OutboxRow[] => broker.store.db.prepare("SELECT * FROM outbox WHERE to_name = ? ORDER BY created_at, rowid").all(name) as unknown as OutboxRow[];
const bodiesOf = (c: FakeClaude): string[] => c.frames.map((f) => parseEnvelope(messageContent(f))!.body);
const inbox = (threadId: string): string => broker.take(threadId).text;
const shell = (name: string): Me => ({ kind: "cli", name });

let ops: FakeClaude;
let docs: FakeClaude;
let builder: Me;
let tester: Me;
let planner: Me;

const claudeMe = (c: FakeClaude): Me => ({ kind: "claude", name: c.name, socketPath: c.socketPath, session: c.sessionId });

before(async () => {
  await broker.start();
  ops = await fakeClaude("ops", process.pid, "idle");
  docs = await fakeClaude("docs", livePid(), "busy");
  for (const t of ["builder", "tester", "planner"]) await broker.hook({ threadId: `thread-${t}`, event: "SessionStart", cwd: `/work/${t}` });
  builder = await codexIdentity("thread-builder");
  tester = await codexIdentity("thread-tester");
  planner = await codexIdentity("thread-planner");
});

after(async () => {
  await closeServer(ops.server);
  await closeServer(docs.server);
  await broker.stop();
});

test("a channel name is # and up to 48 lower-case letters, digits, dots, dashes or underscores, folded to lower case", () => {
  assert.equal(parseChannel("#Deploys"), "deploys");
  assert.equal(parseChannel("  #ci-main_2.0 "), "ci-main_2.0");
  assert.equal(parseChannel("deploys"), "deploys");
  for (const bad of ["#", "", "#has space", "#-lead", `#${"x".repeat(49)}`, "#a/b", "#<tag>", 7]) assert.throws(() => parseChannel(bad), /is not a channel name/, String(bad));
});

test("subscribing records the session durably, once, and unsubscribing removes it; neither fails when repeated", async () => {
  const first = await subscribeTo(builder, "#deploys");
  assert.deepEqual([first.channel, first.changed, first.members.map((m) => m.name)], ["deploys", true, [builder.name]]);
  const again = await subscribeTo(builder, "#Deploys");
  assert.deepEqual([again.changed, again.members.length], [false, 1]);
  await subscribeTo(tester, "#deploys");
  await subscribeTo(claudeMe(docs), "#deploys");
  const listed = await listChannels(builder);
  assert.deepEqual(listed.channels.map((c) => [c.channel, c.members.map((m) => m.name).sort(), c.members.find((m) => m.you)?.name]), [["deploys", [builder.name, "docs", tester.name].sort(), builder.name]]);
  const gone = await unsubscribeFrom(tester, "#deploys");
  assert.deepEqual([gone.changed, gone.members.map((m) => m.name).sort()], [true, [builder.name, "docs"].sort()]);
  assert.equal((await unsubscribeFrom(tester, "#deploys")).changed, false);
  assert.equal((await unsubscribeFrom(tester, "#never-existed")).changed, false);
  await unsubscribeFrom(builder, "#deploys");
  await unsubscribeFrom(claudeMe(docs), "#deploys");
  assert.deepEqual((await listChannels(builder)).channels, []);
});

test("a plain shell has no inbox and cannot subscribe, and a reserved or malformed channel is refused", async () => {
  await assert.rejects(subscribeTo(shell("cli-x"), "#deploys"), /only a Claude Code or Codex session can subscribe/);
  await assert.rejects(subscribeTo(builder, "#all"), /#all is every live session/);
  await assert.rejects(subscribeTo(builder, "#no good"), /is not a channel name/);
  assert.deepEqual((await listChannels(builder)).channels, []);
});

test("membership survives a broker restart", async () => {
  await subscribeTo(builder, "#durable");
  await subscribeTo(claudeMe(ops), "#durable");
  await broker.stop();
  await broker.start();
  const listed = await listChannels(builder);
  assert.deepEqual(listed.channels.map((c) => [c.channel, c.members.map((m) => m.name).sort()]), [["durable", [builder.name, "ops"].sort()]]);
  await unsubscribeFrom(builder, "#durable");
  await unsubscribeFrom(claudeMe(ops), "#durable");
});

test("a post to #topic is routed to each subscriber separately, framed with the channel, and never back to its sender", async () => {
  await subscribeTo(builder, "#release");
  await subscribeTo(tester, "#release");
  await subscribeTo(claudeMe(ops), "#release");
  await subscribeTo(claudeMe(docs), "#release");
  ops.setStatus("idle");
  docs.setStatus("busy");
  const post = await postToChannel(builder, "#release", "v2 is tagged", "normal");
  assert.equal(post.recipients, 3, "the sender is not a recipient");
  assert.deepEqual(post.deliveries.map((d) => d.name).sort(), ["docs", "ops", tester.name].sort());
  assert.ok(post.deliveries.every((d) => d.outcome === "delivered"), JSON.stringify(post.deliveries));
  await until(() => ops.frames.length === 1 && docs.frames.length === 1);
  assert.deepEqual(bodiesOf(ops), ["[#release] v2 is tagged"]);
  assert.deepEqual(bodiesOf(docs), ["[#release] v2 is tagged"]);
  assert.match(inbox("thread-tester"), /\[#release\] v2 is tagged/);
  assert.equal(broker.store.queuedCount("thread-builder"), 0, "the sender is not told its own post");
  const rows = [...outboxTo("ops"), ...outboxTo("docs"), ...outboxTo(tester.name)].filter((r) => r.body_chars === "[#release] v2 is tagged".length);
  assert.equal(rows.length, 3, "one outbox row per delivery");
  assert.equal(new Set(rows.map((r) => r.msg_id)).size, 3, "each delivery has its own message id");
  const decisionOf = (name: string) => JSON.parse(outboxTo(name).at(-1)!.decision) as { rule?: string; by: string };
  assert.equal(decisionOf("ops").rule, "receiver-idle", "the idle session was routed by the idle rule");
  assert.equal(decisionOf("docs").by, "default", "the busy one was routed on its own state");
});

test("each delivery is routed against its own receiver: budgets and the sender limit apply per subscriber", async () => {
  await subscribeTo(tester, "#flood");
  await subscribeTo(planner, "#flood");
  const sentBefore = (name: string) => outboxTo(name).filter((r) => r.from_name === builder.name).length;
  const prior = { tester: sentBefore(tester.name), planner: sentBefore(planner.name) };
  const routes: string[][] = [];
  for (let i = 0; i < 12; i++) {
    const post = await postToChannel(builder, "#flood", `distinct update ${i}`, "normal");
    routes.push(post.deliveries.map((d) => d.route!));
  }
  assert.ok(routes.slice(0, 3).every((r) => r.every((x) => x === "now")), "delivered now while the sender is within its budget");
  assert.deepEqual(routes.at(-1), ["digest", "digest"], "past ten messages to one receiver in ten minutes, each subscriber's delivery is batched");
  const batched = (name: string) => outboxTo(name).filter((r) => r.route === "digest" && JSON.parse(r.decision).rule === "sender-budget").length;
  const expected = (before: number) => Math.max(0, before + 12 - 10);
  assert.deepEqual([batched(tester.name), batched(planner.name)], [expected(prior.tester), expected(prior.planner)], "the eleventh message to one receiver in ten minutes, counting what the sender sent it earlier, is batched");
  await unsubscribeFrom(tester, "#flood");
  await unsubscribeFrom(planner, "#flood");
});

test("a Claude session posting to a channel reaches its Codex subscribers and is told which Claude subscribers to message with its own SendMessage", async () => {
  await subscribeTo(tester, "#native");
  await subscribeTo(claudeMe(docs), "#native");
  const before = docs.frames.length;
  const post = await postToChannel(claudeMe(ops), "#native", "claude says hi", "normal");
  assert.deepEqual(post.deliveries.map((d) => [d.name, d.outcome]).sort(), [["docs", "native"], [tester.name, "delivered"]].sort());
  assert.equal(docs.frames.length, before, "nothing was posted to the Claude subscriber");
  assert.match(inbox("thread-tester"), /\[#native\] claude says hi/);
  const text = formatPost(post);
  assert.match(text, /built-in SendMessage/);
  assert.match(text, /@docs/);
  await unsubscribeFrom(tester, "#native");
  await unsubscribeFrom(claudeMe(docs), "#native");
});

test("a plain shell may post to a channel and reaches Claude subscribers too", async () => {
  await subscribeTo(claudeMe(docs), "#shellpost");
  const before = docs.frames.length;
  const post = await postToChannel(shell("cli-release"), "#shellpost", "from the shell", "normal");
  assert.equal(post.deliveries[0]!.outcome, "delivered");
  await until(() => docs.frames.length === before + 1);
  assert.equal(bodiesOf(docs).at(-1), "[#shellpost] from the shell");
  await unsubscribeFrom(claudeMe(docs), "#shellpost");
});

test("an fyi post to a channel is batched for its subscribers like any fyi message", async () => {
  await subscribeTo(planner, "#addr");
  const post = await postToChannel(builder, "#addr", "via the channel path", "fyi");
  assert.deepEqual(post.deliveries.map((d) => [d.name, d.outcome, d.route]), [[planner.name, "batched", "digest"]]);
  await unsubscribeFrom(planner, "#addr");
});

test("a channel nobody else subscribed to says so and sends nothing; a post is refused when it is empty or too large", async () => {
  const none = await postToChannel(builder, "#empty", "anyone?", "normal");
  assert.deepEqual([none.recipients, none.deliveries], [0, []]);
  assert.match(formatPost(none), /No one but you is subscribed to #empty/);
  await assert.rejects(postToChannel(builder, "#empty", "  ", "normal"), /message is empty/);
  await assert.rejects(postToChannel(builder, "#empty", "x".repeat(70_000), "normal"), /larger than 64 KiB/);
});

test("a subscriber that is gone is reported as not running and not tried, the others still get the post, and it stays subscribed", async () => {
  const gone = await fakeClaude("gone", livePid(), "idle");
  await subscribeTo(claudeMe(gone), "#flaky");
  await subscribeTo(tester, "#flaky");
  await closeServer(gone.server);
  const post = await postToChannel(planner, "#flaky", "still there?", "normal");
  assert.deepEqual(post.deliveries.map((d) => [d.name, d.outcome]), [[tester.name, "delivered"]]);
  assert.deepEqual([post.notRunning.count, post.notRunning.names.map((n) => n.name)], [1, ["gone"]]);
  assert.match(formatPost(post), /Not running, so not tried: @gone \(claude\)\. They stay subscribed\./);
  assert.ok((await listChannels(builder)).channels.find((c) => c.channel === "flaky")!.members.some((m) => m.name === "gone" && !m.live), "membership is kept for a session that may come back");
  await unsubscribeFrom(claudeMe(gone), "#flaky");
  await unsubscribeFrom(tester, "#flaky");
});

test("posting the same request twice delivers once", async () => {
  await subscribeTo(planner, "#once");
  const request = { from: { kind: builder.kind, name: builder.name, addr: `uds:${builder.socketPath}`, session: builder.session, mode: null }, channel: "once", body: "only once", urgency: "normal", requestId: "req-once-1" };
  const first = await brokerCall<{ deliveries: { msgId: string }[] }>("channel_send", request);
  const second = await brokerCall<{ deliveries: { msgId: string }[] }>("channel_send", request);
  assert.equal(first.deliveries[0]!.msgId, second.deliveries[0]!.msgId);
  assert.equal(outboxTo(planner.name).filter((r) => r.msg_id === first.deliveries[0]!.msgId).length, 1);
  await unsubscribeFrom(planner, "#once");
});

test("broadcast reaches every live session except the sender, as fyi or normal, and an urgent broadcast is refused before anything is sent", async () => {
  ops.setStatus("idle");
  const before = { ops: ops.frames.length, docs: docs.frames.length };
  const refused = await postToChannel(builder, "#all", "everyone stop", "urgent").then(
    () => undefined,
    (e: Error) => e.message,
  );
  assert.match(refused ?? "", /an urgent broadcast is refused/);
  assert.equal(ops.frames.length, before.ops);
  const post = await postToChannel(builder, "#all", "deploy window opens at 18:00", "fyi");
  assert.deepEqual(post.deliveries.map((d) => d.name).sort(), ["docs", "ops", planner.name, tester.name].sort(), "every live session but the sender");
  assert.ok(post.deliveries.every((d) => d.route === "digest" || d.route === "now"));
  assert.deepEqual(post.deliveries.filter((d) => d.name !== "ops").map((d) => d.route), ["digest", "digest", "digest"], "fyi is batched for the busy ones");
  const normal = await postToChannel(builder, "#all", "build is green", "normal");
  assert.equal(normal.recipients, 4);
  assert.match(inbox("thread-tester"), /\[#all\] deploy window opens at 18:00/);
});

test("formatting names every subscriber and says whether it is you, and a post lists each message id and how it was routed", async () => {
  await subscribeTo(tester, "#show");
  await subscribeTo(builder, "#show");
  const text = formatChannels(await listChannels(builder));
  assert.match(text, /#show: @/);
  assert.match(text, /\(you\)/);
  const post = await postToChannel(builder, "#show", "formatting check", "normal");
  const out = formatPost(post);
  assert.match(out, /Posted to #show: 1 session/);
  assert.match(out, new RegExp(post.deliveries[0]!.msgId!));
  await unsubscribeFrom(tester, "#show");
  await unsubscribeFrom(builder, "#show");
});

test("the channel upkeep removes members that have not been alive for 30 days and keeps live ones and recent ones", async () => {
  const stale = await fakeClaude("stale", livePid(), "idle");
  await subscribeTo(claudeMe(stale), "#upkeep");
  await subscribeTo(tester, "#upkeep");
  await closeServer(stale.server);
  const members = () => broker.channels.members("upkeep").map((m) => m.name).sort();
  assert.deepEqual(members(), ["stale", tester.name].sort());
  await broker.channels.maintain(Date.now() + 40 * 86_400_000, true);
  assert.deepEqual(members(), [tester.name], "the unreachable one is dropped after 30 days, the live one is kept");
  const recent = await fakeClaude("recent-gone", livePid(), "idle");
  await subscribeTo(claudeMe(recent), "#upkeep");
  await closeServer(recent.server);
  await broker.channels.maintain(Date.now() + 10 * 86_400_000, true);
  assert.deepEqual(members(), ["recent-gone", tester.name].sort(), "an unreachable member that subscribed less than 30 days before the upkeep is kept");
  await unsubscribeFrom(tester, "#upkeep");
});

test("a session can hold at most 32 subscriptions, a post goes to at most 64 live sessions, members that are gone do not count against that and are reported, and the listing is cut", async () => {
  for (let i = 0; i < 32; i++) await subscribeTo(planner, `#cap-${i}`);
  await assert.rejects(subscribeTo(planner, "#cap-32"), /already subscribed to 32 channels/);
  await subscribeTo(planner, "#cap-0");
  const text = formatChannels(await listChannels(planner));
  assert.equal(text.split("\n").filter((l) => l.startsWith("#cap-")).length, 32);
  for (let i = 0; i < 32; i++) await unsubscribeFrom(planner, `#cap-${i}`);

  const db = broker.store.db;
  const insert = db.prepare("INSERT INTO channel_members (channel, member, addr, name, kind, session, subscribed_at, last_seen) VALUES ('crowd', ?, ?, ?, 'codex', ?, 1, ?)");
  for (let i = 0; i < 70; i++) insert.run(`crowd-${i}`, `uds:/run/crowd-${i}.sock`, `crowd-${i}`, `crowd-${i}`, Date.now());
  const target = (i: number) => ({ kind: "codex" as const, addr: `uds:/run/crowd-${i}.sock`, name: `crowd-${i}`, threadId: `crowd-${i}` });
  const sent: string[] = [];
  const crowdService = (liveCount: number) =>
    new ChannelService({
      db,
      send: async (r) => {
        sent.push(String(r.msgId));
        return { msgId: String(r.msgId), status: "sent", decision: { route: "now", by: "default", reason: "stub" }, to: { name: "x", kind: "codex" } };
      },
      targetOf: (addr, name, session) => ({ kind: "codex", addr, name, ...(session && { threadId: session }) }),
      canon: (addr) => addr ?? null,
      live: () => Array.from({ length: liveCount }, (_, i) => target(i)),
      mayReach: () => true,
    });
  const poster = { kind: "cli" as const, name: "poster", addr: null, session: null, mode: null };
  await assert.rejects(crowdService(70).post({ from: poster, channel: "crowd", body: "to everyone", urgency: "normal" }), /#crowd has 70 live recipients; a post goes to at most 64/);
  assert.deepEqual(sent, [], "nothing was sent");
  const mostlyGone = await crowdService(3).post({ from: poster, channel: "crowd", body: "to the few", urgency: "normal" });
  assert.equal(sent.length, 3);
  assert.deepEqual([mostlyGone.deliveries.length, mostlyGone.notRunning.count, mostlyGone.notRunning.names.length], [3, 67, 10], "the 67 sessions that are gone are counted and ten are named");
  assert.ok(mostlyGone.deliveries.every((d) => d.outcome === "delivered"));
  assert.ok(formatPost(mostlyGone).length < 3000, "the result stays small however many members are gone");

  const shown = formatChannels(await listChannels(builder));
  assert.match(shown, /#crowd: .*, and 50 more$/m);
  db.prepare("DELETE FROM channel_members WHERE channel = 'crowd'").run();
});

test("a Claude session that restarted under the same session id still gets the channel's posts at its new socket", async () => {
  const before = await fakeClaude("phoenix", livePid(), "idle");
  await subscribeTo(claudeMe(before), "#reborn");
  await closeServer(before.server);
  const after = await fakeClaude("phoenix", livePid(), "idle", "phoenix-reborn.sock");
  try {
    const post = await postToChannel(builder, "#reborn", "welcome back", "normal");
    assert.deepEqual(post.deliveries.map((d) => [d.name, d.outcome]), [["phoenix", "delivered"]]);
    await until(() => after.frames.length === 1);
    assert.equal(bodiesOf(after)[0], "[#reborn] welcome back");
  } finally {
    await unsubscribeFrom(claudeMe(after), "#reborn");
    await closeServer(after.server);
  }
});

test("two sessions with one name are told apart by their ref in the listing and in a post's result, and only then", async () => {
  const a = await fakeClaude("twin", livePid(), "idle");
  const b = await fakeClaude("twin", livePid(), "idle");
  const record = join(process.env.AGENTSOCKS_CLAUDE_SESSIONS_DIR!, `${b.pid}.json`);
  writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, "utf8")), sessionId: "twin-b-session" }));
  const bMe: Me = { ...claudeMe(b), session: "twin-b-session" };
  await subscribeTo(claudeMe(a), "#twins");
  await subscribeTo(bMe, "#twins");
  await subscribeTo(tester, "#twins");
  try {
    const listing = formatChannels(await listChannels(builder));
    const twins = listing.split("\n").find((l) => l.startsWith("#twins"))!;
    assert.match(twins, /@twin \[[0-9a-f]{6}\].*@twin \[[0-9a-f]{6}\]/);
    assert.doesNotMatch(twins, new RegExp(`@${tester.name} \\[`), "a name that is alone has no ref");
    const post = await postToChannel(builder, "#twins", "which twin", "normal");
    const lines = formatPost(post).split("\n").filter((l) => l.startsWith("- @twin"));
    assert.equal(new Set(lines.map((l) => l.split(" ")[2])).size, 2, "each twin has its own ref in the result");
  } finally {
    for (const m of [claudeMe(a), bMe, tester]) await unsubscribeFrom(m, "#twins");
    await closeServer(a.server);
    await closeServer(b.server);
  }
});

test("repeating a request after the membership changed delivers to each remaining member once and never reports a clash", async () => {
  await subscribeTo(tester, "#shift");
  await subscribeTo(planner, "#shift");
  const party = { kind: builder.kind, name: builder.name, addr: `uds:${builder.socketPath}`, session: builder.session, mode: null };
  const request = { from: party, channel: "shift", body: "membership moves", urgency: "normal", requestId: "req-shift-1" };
  const first = await brokerCall<{ deliveries: { name: string; msgId: string; outcome: string }[] }>("channel_send", request);
  await unsubscribeFrom(tester, "#shift");
  const second = await brokerCall<{ deliveries: { name: string; msgId: string; outcome: string }[] }>("channel_send", request);
  assert.deepEqual(second.deliveries.map((d) => [d.name, d.outcome, d.msgId]), first.deliveries.filter((d) => d.name === planner.name).map((d) => [d.name, d.outcome, d.msgId]));
  await unsubscribeFrom(planner, "#shift");
});

test("a Claude sender whose subscribers are all Claude sessions is told nothing was posted, not that it posted to 0 sessions", async () => {
  const other = await fakeClaude("only-claude", livePid(), "idle");
  await subscribeTo(claudeMe(other), "#claudes");
  try {
    const text = formatPost(await postToChannel(claudeMe(ops), "#claudes", "claude to claude", "normal"));
    assert.match(text, /^Nothing was posted to #claudes through agentsocks\.\nNot posted to @only-claude: you are a Claude session/);
    assert.equal(other.frames.length, 0);
  } finally {
    await unsubscribeFrom(claudeMe(other), "#claudes");
    await closeServer(other.server);
  }
});

test("a broadcast reaches a session once even when the registry lists it twice", async () => {
  const sent: string[] = [];
  const twice = { kind: "claude" as const, addr: "uds:/run/twice.sock", name: "twice", sessionId: "twice-session" };
  const service = new ChannelService({
    db: broker.store.db,
    send: async (r) => {
      sent.push(String(r.msgId));
      return { msgId: String(r.msgId), status: "sent", decision: { route: "now", by: "default", reason: "stub" }, to: { name: "twice", kind: "claude" } };
    },
    targetOf: (addr, name, session) => ({ kind: "claude", addr, name, ...(session && { sessionId: session }) }),
    canon: (addr) => addr ?? null,
    live: () => [twice, { ...twice }],
    mayReach: () => true,
  });
  const post = await service.post({ from: { kind: "cli", name: "announcer", addr: null, session: null, mode: null }, channel: "all", body: "hello all", urgency: "fyi" });
  assert.equal(post.recipients, 1);
  assert.equal(sent.length, 1);
});

test("a Codex thread whose inbox is bound still gets a channel post after a day of silence, and a broadcast skips it", async () => {
  await broker.hook({ threadId: "thread-quiet", event: "SessionStart", cwd: "/work/quiet" });
  const quiet = await codexIdentity("thread-quiet");
  await subscribeTo(quiet, "#quiet-room");
  broker.store.db.prepare("UPDATE threads SET last_seen = ? WHERE thread_id = 'thread-quiet'").run(Date.now() - 48 * 3_600_000);
  try {
    const post = await postToChannel(builder, "#quiet-room", "still reachable", "normal");
    assert.deepEqual(post.deliveries.map((d) => [d.name, d.outcome]), [[quiet.name, "delivered"]]);
    assert.equal(post.notRunning.count, 0);
    assert.ok(!(await postToChannel(builder, "#all", "everyone awake", "fyi")).deliveries.some((d) => d.name === quiet.name), "a broadcast reaches sessions seen in the last day");
  } finally {
    await unsubscribeFrom(quiet, "#quiet-room");
  }
});

test("a channel whose members are all gone says so in one short line", async () => {
  const db = broker.store.db;
  const insert = db.prepare("INSERT INTO channel_members (channel, member, addr, name, kind, session, subscribed_at, last_seen) VALUES ('graveyard', ?, ?, ?, 'claude', ?, 1, ?)");
  for (let i = 0; i < 2000; i++) insert.run(`dead-${i}`, `uds:/run/dead-${i}.sock`, `dead-${i}`, `dead-${i}`, Date.now());
  try {
    const post = await postToChannel(builder, "#graveyard", "anyone?", "normal");
    assert.deepEqual([post.deliveries.length, post.notRunning.count, post.notRunning.names.length], [0, 2000, 10]);
    const text = formatPost(post);
    assert.match(text, /^Nothing was posted to #graveyard through agentsocks\.\nNot running, so not tried: .*, and 1990 more\. They stay subscribed\.$/);
    assert.ok(text.length < 1000);
  } finally {
    db.prepare("DELETE FROM channel_members WHERE channel = 'graveyard'").run();
  }
});
