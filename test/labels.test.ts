import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fakeClaude, inTranscript, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress } from "../src/envelope.ts";
import { codexIdentity, type Me } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";
import { exportLabels, rateMessage } from "../src/labelclient.ts";
import { BODY_CACHE_MS, BodyCache, LabelService, asRouted, formatOwn, formatRate, labelCases, parseRating, sendOf, type LabelExport, type Rating } from "../src/labels.ts";
import { postToChannel, subscribeTo, unsubscribeFrom } from "../src/channelclient.ts";
import { resolve as route, type BudgetView, type MessageView, type ReceiverView } from "../src/router.ts";
import { formatMessageStatus } from "../src/render.ts";
import { messageStatus } from "../src/ops.ts";
import type { Classifier } from "../src/classifier.ts";
import type { OutboxRow } from "../src/store.ts";
import { cat } from "./fakes.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
let classifierImpl: Classifier | undefined;
const broker = new Broker({ wakeEnabled: false, classifier: () => classifierImpl });
let ops: FakeClaude;
let n = 0;

const outbox = (msgId: string): OutboxRow => broker.store.getOutbox(msgId)!;
const labelRows = (msgId: string): Record<string, unknown>[] => broker.store.db.prepare("SELECT * FROM labels WHERE msg_id = ? ORDER BY source").all(msgId) as Record<string, unknown>[];
const decisionOf = (msgId: string) => JSON.parse(outbox(msgId).decision) as { route: string; by: string; rule?: string; reason: string; backend?: string };
const claudeMe = (c: FakeClaude): Me => ({ kind: "claude", name: c.name, socketPath: c.socketPath, session: c.sessionId });
const MINUTE = 60_000;

const read = (me: Me) => broker.take(me.session!);

async function shown(msgId: string): Promise<void> {
  inTranscript(ops, msgId);
  await broker.detectShown(Date.now());
}

async function thread(label: string, state: "idle" | "busy" = "idle", task = "write the docs"): Promise<Me> {
  const id = `thread-lab-${label}-${n++}`;
  await broker.hook({ threadId: id, event: "SessionStart", cwd: `/work/${label}` });
  if (state === "busy") await broker.hook({ threadId: id, event: "UserPromptSubmit", prompt: task });
  return codexIdentity(id);
}

const busy = (me: Me, prompt = "write the docs") => broker.hook({ threadId: me.session!, event: "UserPromptSubmit", prompt });

async function senderWith(name: string, ratings: Rating[]): Promise<Me> {
  const sender = await thread(name);
  const receiver = await thread(`${name}-receiver`);
  for (const [i, rating] of ratings.entries()) {
    const sent = await sendMessage(sender, receiver.name, `${name} update ${i}`);
    assert.equal(sent.route, "now");
    read(receiver);
    await rateMessage(receiver, { rating, messageId: sent.msgId });
  }
  return sender;
}

async function greyZone(sender: Me, urgency: "normal" | "urgent" | "fyi" = "normal") {
  const receiver = await thread(`${sender.name}-busy-${n++}`, "busy");
  return sendMessage(sender, receiver.name, `grey zone ${n++}`, undefined, { urgency });
}

before(async () => {
  await broker.start();
  ops = await fakeClaude("ops", livePid(), "busy");
});

after(async () => {
  await closeServer(ops.server);
  await broker.stop();
});

test("with nothing rated yet, eval-router --own says so instead of scoring nothing", async () => {
  await assert.rejects(exec(process.execPath, [cli, "eval-router", "--own", "--backend", "none"], { env: process.env, timeout: 30_000 }), (e: { stderr?: string }) => /no rated messages with text yet/.test(e.stderr ?? ""));
});

test("a rating names one of three values", () => {
  for (const ok of ["useful-now", "could-wait", "noise"]) assert.equal(parseRating(ok), ok);
  for (const bad of ["urgent", "", undefined, 3, "Noise"]) assert.throws(() => parseRating(bad), /rating must be one of useful-now, could-wait, noise/);
});

test("a Codex receiver rates a message by the id its inbox shows; the label keeps the routing facts, the receiver's task and tool, and the redacted text", async () => {
  const sender = await thread("rater-sender");
  const receiver = await thread("rater-receiver");
  const secret = cat("ghp", "_1234567890abcdefghijklmnopqrstuvwxyz12");
  const sent = await sendMessage(sender, receiver.name, `deploy finished, token ${secret}`);
  const shown = broker.take(receiver.session!).text;
  const id = shown.match(/<peer-message-[0-9a-f]+ id="([^"]+)"/)![1]!;
  assert.equal(id, sent.msgId);
  await busy(receiver, "refactor the auth middleware");
  await broker.hook({ threadId: receiver.session!, event: "PostToolUse", toolName: "Edit" });
  const result = await rateMessage(receiver, { rating: "noise", messageId: id });
  assert.deepEqual([result.msgId, result.rating, result.withText], [id, "noise", true]);
  const [row] = labelRows(id) as { source: string; rating: string; reason: string; route: string; decided_by: string; rule: string; receiver_kind: string; sender_name: string; task: string; last_tool: string; body: string; urgency: string }[];
  assert.deepEqual([row!.source, row!.rating, row!.reason, row!.route, row!.decided_by, row!.rule, row!.receiver_kind, row!.urgency], ["explicit", "noise", "rated", "now", "rule", "receiver-idle", "codex", "normal"]);
  assert.equal(row!.sender_name, `${sender.name} (codex)`);
  assert.deepEqual([row!.task, row!.last_tool], ["refactor the auth middleware", "Edit"]);
  assert.match(row!.body, /^deploy finished, token \[redacted\]$/);
  assert.ok(!JSON.stringify(row).includes(secret));
  await rateMessage(receiver, { rating: "could-wait", messageId: id });
  const again = labelRows(id);
  assert.equal(again.length, 1, "rating again replaces the rating");
  assert.equal(again[0]!.rating, "could-wait");
});

test("a Claude receiver rates the latest message from a sender by name, or just the latest, and the text comes from memory", async () => {
  const sender = await thread("claude-rater-sender");
  const first = await sendMessage(sender, "ops", "first thing");
  await sendMessage(sender, "ops", "second thing, fyi only", undefined, { urgency: "fyi" });
  const third = await sendMessage(sender, "ops", "third thing");
  await shown(first.msgId);
  await shown(third.msgId);
  const byName = await rateMessage(claudeMe(ops), { rating: "could-wait", from: sender.name });
  assert.equal(byName.msgId, third.msgId, "the latest from that sender");
  assert.equal(byName.withText, true);
  assert.equal(labelRows(third.msgId)[0]!.body, "third thing");
  const latest = await rateMessage(claudeMe(ops), { rating: "useful-now" });
  assert.equal(latest.msgId, third.msgId);
  assert.equal(labelRows(third.msgId).length, 1);
  assert.equal((await rateMessage(claudeMe(ops), { rating: "noise", messageId: first.msgId })).msgId, first.msgId);
  assert.equal(JSON.parse(JSON.stringify(labelRows(first.msgId)[0])).task, "session ops in /work/ops", "a Claude session's prompt is never stored, only its session label");
});

test("a message that is no longer in memory is still rated, without its text, and the answer says so", async () => {
  const sender = await thread("no-text-sender");
  const sent = await sendMessage(sender, "ops", "lost to a restart");
  const forgetful = new LabelService({
    db: broker.store.db,
    canon: (addr) => broker.canon(addr),
    receiverContext: (party) => broker.receiverContext(party),
    bodyOf: () => undefined,
  });
  const result = forgetful.rate({ kind: "claude", name: "ops", addr: encodeAddress(ops.socketPath), session: ops.sessionId, mode: null }, "noise", { msgId: sent.msgId });
  assert.equal(result.withText, false);
  assert.equal(labelRows(sent.msgId)[0]!.body, null);
  assert.match(formatRate(result), /without its text/);
});

test("only the receiver can rate a message, and a plain shell, a stranger and an unknown id are refused", async () => {
  const sender = await thread("guard-sender");
  const receiver = await thread("guard-receiver");
  const other = await thread("guard-other");
  const sent = await sendMessage(sender, receiver.name, "for the receiver only");
  await assert.rejects(rateMessage(other, { rating: "noise", messageId: sent.msgId }), /no message .* was delivered to you through agentsocks/);
  await assert.rejects(rateMessage(sender, { rating: "noise", messageId: sent.msgId }), /was delivered to you/);
  await assert.rejects(rateMessage(receiver, { rating: "noise", messageId: "no-such-id" }), /no message no-such-id was delivered to you/);
  await assert.rejects(rateMessage(receiver, { rating: "noise", from: "nobody" }), /no message from that sender was delivered to you/);
  await assert.rejects(rateMessage({ kind: "cli", name: "cli-x" }, { rating: "noise" }), /only a Claude Code or Codex session can rate a message/);
  await assert.rejects(rateMessage(receiver, { rating: "meh" as Rating }), /rating must be one of/);
  assert.equal(labelRows(sent.msgId).length, 0);
});

test("the text kept for rating a Claude receiver's message is redacted, cut, forgotten after two hours and bounded", () => {
  const cache = new BodyCache();
  const secret = cat("ghp", "_1234567890abcdefghijklmnopqrstuvwxyz12");
  cache.remember("m1", `${secret} ${"x".repeat(5000)}`, 1000);
  const text = cache.get("m1", 2000)!;
  assert.ok(!text.includes(secret) && text.length <= 2000);
  assert.equal(cache.get("m1", 1000 + BODY_CACHE_MS), undefined, "expired");
  for (let i = 0; i < 300; i++) cache.remember(`k${i}`, "body", 5000);
  assert.equal(cache.get("k0", 5000), undefined, "the oldest are dropped past 256");
  assert.equal(cache.get("k299", 5000), "body");
});

test("implicit signals: a reply within ten minutes is useful-now, a duplicate is noise, a Codex message unread for two hours while the session kept working is noise, and each is labelled once without text", async () => {
  const sender = await thread("signal-sender");
  const receiver = await thread("signal-receiver");

  const quick = await sendMessage(sender, receiver.name, "can you review PR 41");
  broker.take(receiver.session!);
  await sendMessage(receiver, sender.name, "reviewed, looks good");
  assert.equal(outbox(quick.msgId).status, "replied");

  const slow = await sendMessage(sender, receiver.name, "and PR 42");
  broker.take(receiver.session!);
  await sendMessage(receiver, sender.name, "reviewed that one too");
  broker.store.db.prepare("UPDATE outbox SET replied_at = created_at + ? WHERE msg_id = ?").run(11 * MINUTE, slow.msgId);

  const first = await sendMessage(sender, receiver.name, "same text twice");
  const dup = await sendMessage(sender, receiver.name, "same text twice");
  assert.equal(dup.route, "merge");

  const ignored = await sendMessage(sender, "ops", "ignored by the claude one");
  const away = await thread("signal-away");
  const awaySent = await sendMessage(sender, away.name, "are you there");
  const awayIdle = await thread("signal-idle");
  const idleSent = await sendMessage(sender, awayIdle.name, "idle receiver, no activity");
  const sentAt = outbox(awaySent.msgId).sent_at!;
  broker.store.db.prepare("UPDATE threads SET last_activity = ? WHERE thread_id = ?").run(sentAt + 10 * MINUTE, away.session!);

  const now = Date.now() + 3 * 3_600_000;
  const written = broker.labels.collect(now, true);
  const implicit = (id: string) => labelRows(id).filter((r) => r.source === "implicit") as { rating: string; reason: string; body: string | null; route: string; task: string | null }[];
  assert.deepEqual(implicit(quick.msgId).map((r) => [r.rating, r.reason]), [["useful-now", "replied"]]);
  assert.deepEqual(implicit(slow.msgId), [], "a reply after eleven minutes is not a signal");
  assert.deepEqual(implicit(dup.msgId).map((r) => [r.rating, r.reason, r.route]), [["noise", "merged", "merge"]]);
  assert.deepEqual(implicit(first.msgId), []);
  assert.deepEqual(implicit(awaySent.msgId).map((r) => [r.rating, r.reason]), [["noise", "never-read"]]);
  assert.deepEqual(implicit(idleSent.msgId), [], "a session that did no work after the message may simply have been away");
  assert.deepEqual(implicit(ignored.msgId), [], "a Claude receiver's reading cannot be observed reliably, so it is not a signal");
  assert.ok(written >= 3);
  for (const id of [quick.msgId, dup.msgId, awaySent.msgId]) assert.deepEqual([implicit(id)[0]!.body, implicit(id)[0]!.task], [null, null], "implicit labels keep no text");
  assert.equal(broker.labels.collect(now + 1, true), 0, "each message is labelled once");
  assert.equal(broker.labels.collect(now + 2), 0, "and the sweep does not look again within a minute");
});

test("an explicit rating beats an implicit one for the same message, and ratings older than 180 days are dropped", async () => {
  const sender = await thread("beat-sender");
  const receiver = await thread("beat-receiver");
  const sent = await sendMessage(sender, receiver.name, "reply to me");
  broker.take(receiver.session!);
  await sendMessage(receiver, sender.name, "replied");
  broker.labels.collect(Date.now(), true);
  await rateMessage(receiver, { rating: "noise", messageId: sent.msgId });
  assert.deepEqual(labelRows(sent.msgId).map((r) => [r.source, r.rating]), [["explicit", "noise"], ["implicit", "useful-now"]]);
  const key = (broker.store.db.prepare("SELECT sender_key FROM labels WHERE msg_id = ? LIMIT 1").get(sent.msgId) as { sender_key: string }).sender_key;
  assert.deepEqual(broker.labels.ratingsFor(key, Date.now()), { rated: 1, low: 1 });
  broker.labels.collect(Date.now() + 181 * 86_400_000, true);
  assert.equal(labelRows(sent.msgId).length, 0);
});

const busyReceiver: ReceiverView = { kind: "codex", state: "busy", awaitingReplyFromSender: false };
const normal: MessageView = { body: "hello", urgency: "normal", duplicateOfRecent: false };
const quiet: BudgetView = { receiverNowLast10m: 0, senderToReceiverLast10m: 0 };

test("a sender with at least five rated interrupting messages, three in five of them could-wait or noise, has its grey-zone messages paused; fewer ratings or a smaller share change nothing", () => {
  const paused = (rated: number, low: number) => route(busyReceiver, normal, { ...quiet, senderRatings: { rated, low } });
  for (const [rated, low] of [[5, 3], [6, 4], [10, 10], [5, 5]] as const) {
    const d = paused(rated, low);
    assert.deepEqual([d.route, d.by, d.rule], ["pause", "rule", "sender-history"], `${low} of ${rated}`);
    assert.match(d.reason, new RegExp(`^${low} of ${rated} of this sender's earlier messages delivered now were rated could-wait or noise`));
  }
  for (const [rated, low] of [[4, 4], [5, 2], [10, 5], [1, 1], [5, 0]] as const) assert.equal(paused(rated, low).route, "now", `${low} of ${rated}`);
  assert.equal(paused(6, 4).urgency, "normal");
});

test("the history never touches what the rules decide, never raises a route, and says what the classifier had chosen", async () => {
  const history = { ...quiet, senderRatings: { rated: 6, low: 5 } };
  assert.equal(route(busyReceiver, { ...normal, urgency: "urgent" }, history).rule, "urgent");
  assert.equal(route(busyReceiver, { ...normal, urgency: "fyi" }, history).route, "digest");
  assert.equal(route({ ...busyReceiver, state: "idle" }, normal, history).rule, "receiver-idle");
  assert.equal(route({ ...busyReceiver, awaitingReplyFromSender: true }, normal, history).rule, "awaited-reply");
  const outcome = (r: "now" | "pause" | "digest") => ({ backend: "fake", threshold: 0.5, latencyMs: 3, result: { route: r, confidence: 0.9 } });
  const wantsNow = route(busyReceiver, normal, history, outcome("now"));
  assert.deepEqual([wantsNow.route, wantsNow.rule, wantsNow.backend, wantsNow.confidence], ["pause", "sender-history", "fake", 0.9]);
  assert.match(wantsNow.reason, /The fake classifier had chosen now \(confidence 0\.9\)\.$/);
  const wantsDigest = route(busyReceiver, normal, history, outcome("digest"));
  assert.deepEqual([wantsDigest.route, wantsDigest.by], ["digest", "classifier"]);
});

test("end to end: a sender whose interrupting messages receivers rated could-wait or noise gets its next grey-zone message paused, with the history in the recorded reason", async () => {
  const noisy = await senderWith("noisy", ["noise", "could-wait", "noise", "useful-now", "noise", "useful-now"]);
  const calm = await senderWith("calm", ["useful-now", "useful-now", "useful-now", "noise", "useful-now", "useful-now"]);
  const demoted = await greyZone(noisy);
  assert.equal(demoted.route, "pause");
  assert.deepEqual([decisionOf(demoted.msgId).by, decisionOf(demoted.msgId).rule], ["rule", "sender-history"]);
  assert.match(decisionOf(demoted.msgId).reason, /^4 of 6 of this sender's earlier messages delivered now were rated could-wait or noise by their receivers/);
  const viewer = await codexIdentity(outbox(demoted.msgId).to_thread!);
  const status = formatMessageStatus(await messageStatus(viewer, demoted.msgId));
  assert.match(status, /routed pause \(rule, sender-history\): 4 of 6 of this sender's earlier messages/);
  assert.equal((await greyZone(calm)).route, "now", "a sender mostly rated useful is not touched");
  assert.equal((await greyZone(noisy, "urgent")).route, "now", "urgent goes by its own rule");
  assert.equal((await greyZone(noisy, "fyi")).route, "digest");
  classifierImpl = { name: "fake", remote: false, threshold: 0.5, timeoutMs: 500, classify: async () => ({ route: "now", confidence: 0.95 }) };
  const withClassifier = await greyZone(noisy);
  classifierImpl = undefined;
  assert.equal(withClassifier.route, "pause");
  assert.match(decisionOf(withClassifier.msgId).reason, /The fake classifier had chosen now \(confidence 0\.95\)\./);
});

test("the sender key written when a rating is stored is the one the router looks up, for a Claude session, a plain shell and a Codex thread alike", async () => {
  const claudeSender = claudeMe(ops);
  const shellSender: Me = { kind: "cli", name: "cli-noisy-shell" };
  for (const sender of [claudeSender, shellSender]) {
    for (let i = 0; i < 5; i++) {
      const receiver = await thread(`keyed-${sender.kind}-${i}`);
      const sent = await sendMessage(sender, receiver.name, `${sender.name} update ${i}`);
      assert.equal(sent.route, "now");
      read(receiver);
      await rateMessage(receiver, { rating: "noise", messageId: sent.msgId });
    }
    const next = await greyZone(sender);
    assert.equal(next.route, "pause", `${sender.kind} sender`);
    assert.equal(decisionOf(next.msgId).rule, "sender-history");
  }
});

test("the history looks at the last 30 days and at one sender", async () => {
  const sender = await senderWith("aged", ["noise", "noise", "noise", "noise", "noise"]);
  assert.equal((await greyZone(sender)).route, "pause");
  broker.store.db.prepare("UPDATE labels SET msg_at = msg_at - ? WHERE sender_name = ?").run(31 * 86_400_000, `${sender.name} (codex)`);
  assert.equal((await greyZone(sender)).route, "now", "older ratings no longer count");
});

test("export gives one JSON object per label with the text only where it is known, and eval-router --own scores the router on the rated messages with text", async () => {
  const labels = await exportLabels();
  assert.ok(labels.length > 0);
  for (const l of labels) {
    assert.equal(l.v, 1);
    assert.ok(["useful-now", "could-wait", "noise"].includes(l.rating));
    assert.equal(l.decision, { "useful-now": "now", "could-wait": "pause", noise: "digest" }[l.rating]);
    if (l.source === "implicit") assert.equal(l.message, null);
  }
  const withText = await exportLabels({ textOnly: true });
  assert.ok(withText.length > 0 && withText.every((l) => l.message !== null && l.source === "explicit"));
  const cases = labelCases(labels);
  assert.equal(cases.length, withText.length);
  assert.deepEqual(Object.keys(cases[0]!).sort(), ["decision", "message", "task"]);
  const r = await exec(process.execPath, [cli, "eval-router", "--own", "--backend", "none", "--json"], { env: process.env, timeout: 30_000 });
  const report = JSON.parse(r.stdout) as { cases: number; backend: string; own: { labels: number; explicit: number; withText: number; judged: number; matched: number } };
  assert.equal(report.cases, withText.length);
  assert.equal(report.backend, "none");
  assert.deepEqual([report.own.labels, report.own.withText], [labels.length, withText.length]);
  assert.ok(report.own.matched <= report.own.judged);
  const text = await exec(process.execPath, [cli, "eval-router", "--own", "--backend", "none"], { env: process.env, timeout: 30_000 });
  assert.match(text.stdout, /Router evaluation: \d+ cases/);
  assert.match(text.stdout, /Your own traffic: \d+ labelled messages \(\d+ rated by receivers, \d+ from signals\), \d+ with text/);
  assert.match(text.stdout, /As routed at the time, over the \d+ rated by receivers: \d+ routes matched the rating/);
  await assert.rejects(exec(process.execPath, [cli, "eval-router", "--own", "--file", "x.json"], { env: process.env }), (e: { stderr?: string }) => /--own and --file are two different sets/.test(e.stderr ?? ""));
});

test("labels export prints the JSONL to a person, refuses an agent, and leaves training to the user", async () => {
  const r = await exec(process.execPath, [cli, "labels", "export"], { env: process.env, timeout: 30_000 });
  const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as { v: number; msg_id: string });
  assert.ok(lines.length > 0 && lines.every((l) => l.v === 1 && typeof l.msg_id === "string"));
  assert.match(r.stderr, /agentsocks: \d+ labels \(\d+ with text; only those are usable for fine-tuning\)/);
  const textOnly = await exec(process.execPath, [cli, "labels", "export", "--text-only"], { env: process.env, timeout: 30_000 });
  assert.ok(textOnly.stdout.trim().split("\n").every((l) => (JSON.parse(l) as { message: unknown }).message !== null));
  await assert.rejects(exec(process.execPath, [cli, "labels", "export"], { env: { ...process.env, CODEX_THREAD_ID: "thread-an-agent" }, timeout: 30_000 }), (e: { stderr?: string; stdout?: string }) => /for a person at a shell, not for an agent/.test(e.stderr ?? "") && !(e.stdout ?? "").includes("msg_id"));
  await assert.rejects(exec(process.execPath, [cli, "labels"], { env: process.env }), (e: { stderr?: string }) => /usage: agentsocks labels export/.test(e.stderr ?? ""));
  await assert.rejects(exec(process.execPath, [cli, "labels", "export", "--since", "0"], { env: process.env }), (e: { stderr?: string }) => /--since must be a number of days above 0/.test(e.stderr ?? ""));
});

test("the sender filter treats _ and non-ASCII letters as themselves", async () => {
  const sender = await thread("underscore-sender");
  const receiver = await thread("underscore-receiver");
  broker.store.updateThread(sender.session!, { name: "my_proj" });
  const a = await sendMessage({ ...sender, name: "my_proj" }, receiver.name, "from the underscore name");
  broker.store.updateThread(sender.session!, { name: "Zoë-builder" });
  const b = await sendMessage({ ...sender, name: "Zoë-builder" }, receiver.name, "from the accented name");
  const decoy = await thread("decoy-sender");
  broker.store.updateThread(decoy.session!, { name: "myXproj" });
  await sendMessage({ ...decoy, name: "myXproj" }, receiver.name, "from a name the underscore must not match");
  read(receiver);
  assert.equal((await rateMessage(receiver, { rating: "noise", from: "my_proj" })).msgId, a.msgId);
  assert.equal((await rateMessage(receiver, { rating: "noise", from: "zoë-builder" })).msgId, b.msgId);
});

test("eval-router --own refuses a classifier that is not on this machine unless --allow-remote is given, and --allow-remote means nothing without --own", async () => {
  const { writeFileSync, rmSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const sender = await thread("egress-sender");
  const receiver = await thread("egress-receiver");
  const sent = await sendMessage(sender, receiver.name, "text that must not leave unasked");
  read(receiver);
  await rateMessage(receiver, { rating: "noise", messageId: sent.msgId });
  const config = process.env.AGENTSOCKS_CONFIG!;
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ classifier: { backend: "systemone", url: "https://classifier.invalid", allowRemote: true } }));
  try {
    const refused = await exec(process.execPath, [cli, "eval-router", "--own"], { env: process.env, timeout: 30_000 }).then(
      () => "ran",
      (e: { stderr?: string }) => e.stderr ?? "",
    );
    assert.match(refused, /through the classifier in effect, which is not on this machine\. Run it again with --allow-remote/);
    await assert.rejects(exec(process.execPath, [cli, "eval-router", "--allow-remote"], { env: process.env }), (e: { stderr?: string }) => /--allow-remote only applies to --own/.test(e.stderr ?? ""));
    const none = await exec(process.execPath, [cli, "eval-router", "--own", "--backend", "none", "--json"], { env: process.env, timeout: 30_000 });
    assert.equal((JSON.parse(none.stdout) as { backend: string }).backend, "none");
  } finally {
    rmSync(config, { force: true });
  }
});

test("a message that was held in a digest cannot be rated until it is delivered, and a Claude receiver may name a Codex sender the way its envelope shows it", async () => {
  const sender = await thread("held-sender");
  const receiver = await thread("held-receiver", "busy");
  const held = await sendMessage(sender, receiver.name, "FYI the dump moved", undefined, { urgency: "fyi" });
  assert.equal(held.route, "digest");
  await assert.rejects(rateMessage(receiver, { rating: "noise", from: sender.name }), /no message from that sender was delivered to you/);
  broker.take(receiver.session!);
  assert.equal((await rateMessage(receiver, { rating: "noise", from: sender.name })).msgId, held.msgId);
  const heldForClaude = await sendMessage(sender, "ops", "FYI for the claude one", undefined, { urgency: "fyi" });
  assert.equal(heldForClaude.route, "digest");
  await assert.rejects(rateMessage(claudeMe(ops), { rating: "noise", messageId: heldForClaude.msgId }), /was delivered to you/);
  const direct = await sendMessage(sender, "ops", "now for the claude one");
  await shown(direct.msgId);
  const bySeenName = await rateMessage(claudeMe(ops), { rating: "could-wait", from: `${sender.name} (codex)` });
  assert.equal(bySeenName.msgId, direct.msgId);
});

test("rating a Claude receiver's message again after its text left memory keeps the text it was first stored with", async () => {
  const sender = await thread("keep-text-sender");
  const sent = await sendMessage(sender, "ops", "text that matters");
  await shown(sent.msgId);
  await rateMessage(claudeMe(ops), { rating: "noise", messageId: sent.msgId });
  const forgetful = new LabelService({ db: broker.store.db, canon: (addr) => broker.canon(addr), receiverContext: (party) => broker.receiverContext(party), bodyOf: () => undefined });
  const again = forgetful.rate({ kind: "claude", name: "ops", addr: encodeAddress(ops.socketPath), session: ops.sessionId, mode: null }, "could-wait", { msgId: sent.msgId });
  assert.equal(again.rating, "could-wait");
  assert.equal(labelRows(sent.msgId)[0]!.body, "text that matters");
});

test("the deliveries of one channel post count as one send, however many subscribers rated it", async () => {
  const poster = await thread("fan-poster");
  const members: Me[] = [];
  for (let i = 0; i < 5; i++) {
    const m = await thread(`fan-member-${i}`);
    await subscribeTo(m, "#fan-rated");
    members.push(m);
  }
  const post = await postToChannel(poster, "#fan-rated", "one announcement", "normal");
  assert.equal(post.deliveries.length, 5);
  for (const [i, m] of members.entries()) {
    read(m);
    await rateMessage(m, { rating: "noise", messageId: post.deliveries[i]!.msgId! });
  }
  const key = (broker.store.db.prepare("SELECT sender_key FROM labels WHERE msg_id = ? LIMIT 1").get(post.deliveries[0]!.msgId!) as { sender_key: string }).sender_key;
  assert.deepEqual(broker.labels.ratingsFor(key, Date.now()), { rated: 1, low: 1 });
  assert.equal((await greyZone(poster)).route, "now", "one rated post is not five rated messages");
  for (let i = 0; i < 4; i++) {
    const more = await postToChannel(poster, "#fan-rated", `announcement ${i + 2}`, "normal");
    for (const [j, m] of members.entries()) {
      read(m);
      await rateMessage(m, { rating: "noise", messageId: more.deliveries[j]!.msgId! });
    }
  }
  assert.deepEqual(broker.labels.ratingsFor(key, Date.now()), { rated: 5, low: 5 });
  assert.equal((await greyZone(poster)).route, "pause");
  for (const m of members) await unsubscribeFrom(m, "#fan-rated");
});

test("the sender of a paused message is told the receivers' ratings are why", async () => {
  const noisy = await senderWith("told-why", ["noise", "noise", "noise", "noise", "noise"]);
  const sent = await greyZone(noisy);
  assert.equal(sent.route, "pause");
  assert.equal(sent.note, "Delivered. Most of your earlier messages were rated could-wait or noise by their receivers, so this one reaches them when their current turn ends. Send with urgency urgent if it cannot wait.");
});

test("an export bigger than one response is delivered in pages, none lost and none repeated", async () => {
  const db = broker.store.db;
  const insert = db.prepare(
    "INSERT INTO labels (msg_id, source, rating, reason, created_at, msg_at, receiver_addr, receiver_kind, sender_key, route, body) VALUES (?, 'explicit', 'noise', 'rated', ?, ?, 'uds:/x/r.sock', 'codex', 'anon:bulk', 'now', ?)",
  );
  const before = (await exportLabels()).length;
  const body = "z".repeat(2000);
  for (let i = 0; i < 1500; i++) insert.run(`bulk-${i}`, Date.now(), Date.now(), body);
  const all = await exportLabels();
  assert.equal(all.length, before + 1500);
  assert.equal(new Set(all.map((l) => `${l.msg_id}|${l.source}`)).size, all.length, "none repeated");
  assert.equal(all.filter((l) => l.msg_id.startsWith("bulk-")).length, 1500);
  const page = broker.labels.export({ afterId: 0 });
  assert.ok(page.next !== null && JSON.stringify(page.rows).length < 1_000_000, "a page stays under the 1 MiB line limit");
  const cli = await exec(process.execPath, [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "labels", "export"], { env: process.env, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(cli.stdout.trim().split("\n").length, before + 1500);
  db.prepare("DELETE FROM labels WHERE msg_id LIKE 'bulk-%'").run();
});

test("as routed counts only the receivers' own ratings, and says how many routes matched and how many interrupted a receiver that rated them down", () => {
  const label = (source: "explicit" | "implicit", rating: Rating, route: "now" | "pause" | "digest" | "merge", message: string | null): LabelExport => ({
    v: 1,
    at: "2026-10-13T00:00:00.000Z",
    source,
    reason: source === "explicit" ? "rated" : "replied",
    rating,
    decision: { "useful-now": "now" as const, "could-wait": "pause" as const, noise: "digest" as const }[rating],
    task: null,
    message,
    last_tool: null,
    receiver: { kind: "codex" },
    sender: { name: "s", kind: "codex" },
    urgency: "normal",
    routed: { route, by: null, rule: null, confidence: null },
    msg_id: `m-${Math.random()}`,
  });
  const summary = asRouted([
    label("explicit", "useful-now", "now", "a"),
    label("explicit", "noise", "now", "b"),
    label("explicit", "could-wait", "pause", null),
    label("explicit", "noise", "merge", "c"),
    label("implicit", "useful-now", "digest", null),
    label("implicit", "noise", "merge", null),
  ]);
  assert.deepEqual(summary, { labels: 6, explicit: 4, withText: 3, judged: 3, matched: 2, deliveredNowButLow: 1 });
  assert.match(formatOwn(summary), /over the 3 rated by receivers: 2 routes matched the rating \(66\.7%\); 1 were delivered now to a receiver that rated the message could-wait or noise\./);
});

test("a flag given without its value is an error, not a silent default", async () => {
  await assert.rejects(exec(process.execPath, [cli, "labels", "export", "--since"], { env: process.env }), (e: { stderr?: string }) => /--since needs a value/.test(e.stderr ?? ""));
  await assert.rejects(exec(process.execPath, [cli, "eval-router", "--own", "--file"], { env: process.env }), (e: { stderr?: string }) => /--file needs a value/.test(e.stderr ?? ""));
  await assert.rejects(exec(process.execPath, [cli, "send", "--urgency"], { env: process.env }), (e: { stderr?: string }) => /--urgency needs a value/.test(e.stderr ?? ""));
});

test("a message that is still unread is not rated by mistake for one the receiver has seen", async () => {
  const sender = await thread("unread-sender");
  const receiver = await thread("unread-receiver", "busy");
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) seen.push((await sendMessage(sender, receiver.name, `seen ${i}`)).msgId);
  read(receiver);
  const unread = await sendMessage(sender, receiver.name, "arrived after the last read");
  assert.equal(unread.route, "pause");
  assert.equal((await rateMessage(receiver, { rating: "noise", from: sender.name })).msgId, seen[2], "the latest one it has read");
  const claude = await fakeClaude("unread-claude", livePid(), "busy");
  try {
    const sent: string[] = [];
    for (let i = 0; i < 4; i++) sent.push((await sendMessage(sender, "unread-claude", `claude message ${i}`)).msgId);
    assert.equal(JSON.parse(outbox(sent[3]!).decision).route, "pause");
    const me = claudeMe(claude);
    assert.equal((await rateMessage(me, { rating: "noise", from: sender.name })).msgId, sent[2], "a paused message nobody saw is skipped");
    await assert.rejects(rateMessage(me, { rating: "noise", messageId: sent[3]! }), /was delivered to you through agentsocks \(a message counts once you have seen it\)/);
    inTranscript(claude, sent[3]!);
    assert.equal((await rateMessage(me, { rating: "noise", from: sender.name })).msgId, sent[3], "once its transcript shows it, rating needs no wait for the sweep");
  } finally {
    await closeServer(claude.server);
  }
});

test("fan-out ids group into one send and ids that only look similar do not", () => {
  assert.equal(sendOf("3f2c1a9e-0000-4000-8000-000000000001:0123456789"), "3f2c1a9e-0000-4000-8000-000000000001");
  assert.equal(sendOf("A-1a2b3c:3"), "A-1a2b3c");
  for (const id of ["a:1", "a:2", "plain-uuid", "x:0123", "A-1a2b3c:abc", "req:0123456789ab"]) assert.equal(sendOf(id), id, id);
});

test("eval-router --allow-remote is for a person: an agent that gives the consent itself is refused before anything is read", async () => {
  await assert.rejects(exec(process.execPath, [cli, "eval-router", "--own", "--allow-remote"], { env: { ...process.env, CODEX_THREAD_ID: "thread-an-agent" }, timeout: 30_000 }), (e: { stderr?: string }) => /for a person at a shell, not for an agent/.test(e.stderr ?? ""));
});
