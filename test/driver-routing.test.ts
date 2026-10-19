import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Broker } from "../src/broker.ts";
import { decide, decideByRules, resolve, type BudgetView, type MessageView, type ReceiverView } from "../src/router.ts";
import { deliveryNote, type Party, type Target } from "../src/routing.ts";
import { formatPost } from "../src/channels.ts";
import { encodeAddress } from "../src/envelope.ts";
import { threadSocketPath } from "../src/paths.ts";
import type { Classifier } from "../src/classifier.ts";

const receiver = (over: Partial<ReceiverView> = {}): ReceiverView => ({ kind: "codex", state: "busy", awaitingReplyFromSender: false, ...over });
const message = (over: Partial<MessageView> = {}): MessageView => ({ body: "hello", urgency: "normal", duplicateOfRecent: false, ...over });
const budget = (over: Partial<BudgetView> = {}): BudgetView => ({ receiverNowLast10m: 0, senderToReceiverLast10m: 0, ...over });
const digestClassifier = (): Classifier => ({ name: "fake", remote: false, threshold: 0.6, timeoutMs: 50, classify: () => Promise.resolve({ route: "digest", confidence: 0.9 }) });

test("rules: a non-driver sender to a driven session digests, or pauses when awaited", () => {
  const driven = { driverAddr: "uds:driver", senderIsDriver: false };
  const d = decideByRules(receiver(driven), message(), budget());
  assert.deepEqual([d?.route, d?.by, d?.rule], ["digest", "rule", "not-from-driver"]);
  assert.match(d!.reason, /not from the receiver's driver/);
  const awaited = decideByRules(receiver({ ...driven, awaitingReplyFromSender: true }), message(), budget());
  assert.deepEqual([awaited?.route, awaited?.rule], ["pause", "not-from-driver"]);
  assert.match(awaited!.reason, /not from the receiver's driver/);
});

test("rules: the driver's own messages and undriven sessions route exactly as today", () => {
  assert.equal(decideByRules(receiver({ driverAddr: "uds:driver", senderIsDriver: true, state: "idle" }), message(), budget())?.rule, "receiver-idle");
  assert.equal(decideByRules(receiver({ state: "busy" }), message(), budget()), undefined);
  assert.equal(decideByRules(receiver({ driverAddr: null, state: "idle" }), message(), budget())?.rule, "receiver-idle");
});

test("rules: a non-driver digest holds even when the receiver is idle or the sender is loud", () => {
  const driven = { driverAddr: "uds:driver", senderIsDriver: false };
  assert.equal(decideByRules(receiver({ ...driven, state: "idle" }), message(), budget())?.route, "digest");
  assert.equal(decideByRules(receiver(driven), message(), budget({ senderToReceiverLast10m: 50 }))?.route, "digest");
});

test("a report to its driver never batches, skips the sender budget and fyi, keeps urgent counting", async () => {
  const report = { senderDrivenByReceiver: true };
  assert.deepEqual([decideByRules(receiver(report), message(), budget())?.route, decideByRules(receiver(report), message(), budget())?.rule], ["pause", "report-to-driver"]);
  assert.match(decideByRules(receiver(report), message(), budget())!.reason, /from a session this receiver drives/);
  assert.equal(decideByRules(receiver({ ...report, state: "idle" }), message(), budget())?.route, "now");
  assert.equal(decideByRules(receiver(report), message(), budget({ senderToReceiverLast10m: 50 }))?.route, "pause");
  assert.equal(decideByRules(receiver(report), message({ urgency: "fyi" }), budget())?.route, "pause");
  assert.deepEqual([decideByRules(receiver(report), message({ duplicateOfRecent: true }), budget())?.route, decideByRules(receiver(report), message({ duplicateOfRecent: true }), budget())?.rule], ["merge", "duplicate"]);
  assert.equal(decideByRules(receiver(report), message({ urgency: "urgent" }), budget())?.route, "now");
  assert.deepEqual([decideByRules(receiver(report), message({ urgency: "urgent" }), budget({ receiverNowLast10m: 6 }))?.route, decideByRules(receiver(report), message({ urgency: "urgent" }), budget({ receiverNowLast10m: 6 }))?.rule], ["pause", "receiver-budget"]);
  const floored = resolve(receiver(report), message({ duplicateOfRecent: true, duplicateOfPending: "pause" }), budget());
  assert.deepEqual([floored.route, floored.rule], ["pause", "report-to-driver"]);
  const d = await decide(receiver(report), message({ body: "routine wrap-up finished" }), budget(), digestClassifier());
  assert.equal(d.route, "pause", "a chatter-like report never takes the classifier digest path");
});

const broker = new Broker({ classifier: () => undefined, wakeEnabled: false });

function codexAddr(id: string): string {
  return encodeAddress(threadSocketPath(id));
}

function codexParty(id: string, name: string): Party {
  return { kind: "codex", name, addr: codexAddr(id), session: id, mode: null };
}

function codexTarget(id: string, name: string): Target {
  return { kind: "codex", addr: codexAddr(id), name, threadId: id };
}

function bindDriver(worker: string, driver: string, name: string): void {
  broker.store.updateThread(worker, { driver_addr: broker.canon(codexAddr(driver)), driver_name: name });
}

function taskCount(): number {
  return Number((broker.store.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n);
}

before(async () => {
  await broker.start();
  await broker.register("drouteworker", { cwd: "/w/droute", state: "busy" });
  await broker.register("droutedriver", { cwd: "/w/droute", state: "busy" });
  await broker.register("droutestranger", { cwd: "/w/droute", state: "busy" });
  await broker.register("drouteboss2", { cwd: "/w/droute", state: "busy" });
  await broker.register("drouterep2", { cwd: "/w/droute", state: "busy" });
  broker.store.updateThread("drouteworker", { state: "busy" });
  broker.store.updateThread("droutedriver", { state: "busy" });
  bindDriver("drouteworker", "droutedriver", "boss");
  bindDriver("drouterep2", "drouteboss2", "boss2");
});

after(async () => {
  await broker.stop();
});

test("routing: non-driver senders digest with a not-from-driver reason, urgent downgraded to normal", async () => {
  const r = await broker.routeSend({ msgId: randomUUID(), from: codexParty("droutestranger", "stranger"), to: codexTarget("drouteworker", "worker"), body: "you should rebuild the index", urgency: "normal" });
  assert.equal(r.decision.route, "digest");
  assert.equal(r.decision.rule, "not-from-driver");
  assert.match(r.decision.reason, /not from the receiver's driver/);
  const urgent = await broker.routeSend({ msgId: randomUUID(), from: codexParty("droutestranger", "stranger"), to: codexTarget("drouteworker", "worker"), body: "drop everything and rebuild now", urgency: "urgent" });
  assert.equal(urgent.decision.route, "digest");
  assert.equal(urgent.decision.urgency, "normal");
  assert.equal(broker.store.getOutbox(urgent.msgId)!.urgency, "normal");
  const fromDriver = await broker.routeSend({ msgId: randomUUID(), from: codexParty("droutedriver", "boss"), to: codexTarget("drouteworker", "worker"), body: "rebuild the index when ready", urgency: "normal" });
  assert.equal(fromDriver.decision.route, "now", "the driver's own messages route exactly as today");
  assert.notEqual(fromDriver.decision.rule, "not-from-driver");
});

test("routing: a non-driver answer to the worker's own message pauses instead of digesting", async () => {
  await broker.routeSend({ msgId: randomUUID(), from: codexParty("drouteworker", "worker"), to: codexTarget("droutestranger", "stranger"), body: "stranger, what did the deploy say?", urgency: "normal" });
  const r = await broker.routeSend({ msgId: randomUUID(), from: codexParty("droutestranger", "stranger"), to: codexTarget("drouteworker", "worker"), body: "deploy said green", urgency: "normal" });
  assert.equal(r.decision.route, "pause");
  assert.equal(r.decision.rule, "not-from-driver");
});

test("sender note: non-driver senders are told the worker may not act", async () => {
  const r = await broker.routeSend({ msgId: randomUUID(), from: codexParty("droutestranger", "stranger"), to: codexTarget("drouteworker", "worker"), body: "one more request", urgency: "normal" });
  const liveDriver = broker.store.getThread("droutedriver")!.name;
  assert.match(deliveryNote(r, "normal"), new RegExp(`Delivered as information: .* works for ${liveDriver} and may not act on it\\. Ask ${liveDriver} if you need it to do something\\.`));
});

test("tasks: send_task from a non-driver is refused and stores nothing, the driver succeeds", async () => {
  const liveDriver = broker.store.getThread("droutedriver")!.name;
  bindDriver("drouteworker", "droutedriver", liveDriver);
  const before = taskCount();
  await assert.rejects(
    broker.tasks.create({ from: codexParty("droutestranger", "stranger"), to: codexTarget("drouteworker", "worker"), title: "Do this", body: "details" }),
    new RegExp(`Delivered as information: .* works for ${liveDriver} and may not act on it\\. Ask ${liveDriver} if you need it to do something\\.`),
  );
  assert.equal(taskCount(), before, "a refused task is never stored");
  const ok = await broker.tasks.create({ from: codexParty("droutedriver", "boss"), to: codexTarget("drouteworker", "worker"), title: "Do this", body: "details" });
  assert.ok(ok.task.id);
  assert.equal(taskCount(), before + 1);
});

test("channels: channel and broadcast posts to a driven session are non-driver messages with the note", async () => {
  broker.channels.subscribe(codexParty("drouteworker", "worker"), "huddle");
  const post = await broker.channels.post({ from: codexParty("droutestranger", "stranger"), channel: "huddle", body: "crew update", urgency: "normal" });
  const liveDriver = broker.store.getThread("droutedriver")!.name;
  const worker = post.deliveries.find((d) => d.name === "worker")!;
  assert.match(worker.reason ?? "", /not from the receiver's driver/);
  assert.match(formatPost(post), new RegExp(`Delivered as information: .* works for ${liveDriver} and may not act on it\\.`));
  const cast = await broker.channels.post({ from: codexParty("droutestranger", "stranger"), channel: "all", body: "all-hands note", urgency: "normal" });
  assert.match(formatPost(cast), new RegExp(`Delivered as information: .* works for ${liveDriver} and may not act on it\\.`));
});

test("a busy driver still gets its worker's chatter-like reports unbatched and unbilled to the sender", async () => {
  await broker.routeSend({ msgId: randomUUID(), from: codexParty("drouteboss2", "boss2"), to: codexTarget("drouterep2", "rep2"), body: "finish the wrap-up", urgency: "normal" });
  const report = await broker.routeSend({ msgId: randomUUID(), from: codexParty("drouterep2", "rep2"), to: codexTarget("drouteboss2", "boss2"), body: "routine wrap-up finished, nothing urgent", urgency: "normal" });
  assert.ok(report.decision.route === "pause" || report.decision.route === "now", `report routes ${report.decision.route}, never digest or merge`);
  assert.notEqual(report.decision.rule, "sender-budget");
  for (let i = 0; i < 10; i++) {
    await broker.routeSend({ msgId: randomUUID(), from: codexParty("drouterep2", "rep2"), to: codexTarget("drouteboss2", "boss2"), body: `status update ${i}`, urgency: "normal" });
  }
  const over = await broker.routeSend({ msgId: randomUUID(), from: codexParty("drouterep2", "rep2"), to: codexTarget("drouteboss2", "boss2"), body: "status update over budget", urgency: "normal" });
  assert.ok(over.decision.route === "pause" || over.decision.route === "now", "past the sender budget a report still never batches");
  assert.notEqual(over.decision.rule, "sender-budget");
  const fyi = await broker.routeSend({ msgId: randomUUID(), from: codexParty("drouterep2", "rep2"), to: codexTarget("drouteboss2", "boss2"), body: "fyi only", urgency: "fyi" });
  assert.equal(fyi.decision.route, "digest", "past 12 floors an hour a report routes normally");
  const dupe = await broker.routeSend({ msgId: randomUUID(), from: codexParty("drouterep2", "rep2"), to: codexTarget("drouteboss2", "boss2"), body: "status update over budget", urgency: "normal" });
  assert.deepEqual([dupe.decision.route, dupe.decision.rule], ["merge", "duplicate"], "a delivered duplicate merges instead of repeating the interruption");
});

test("urgent reports still count against the receiver budget", async () => {
  await broker.register("drouteboss3", { cwd: "/w/droute", state: "busy" });
  await broker.register("drouterep3", { cwd: "/w/droute", state: "busy" });
  broker.store.updateThread("drouteboss3", { state: "busy" });
  bindDriver("drouterep3", "drouteboss3", "boss3");
  for (let i = 0; i < 6; i++) {
    const r = await broker.routeSend({ msgId: randomUUID(), from: codexParty("drouterep3", "rep3"), to: codexTarget("drouteboss3", "boss3"), body: `urgent item ${i}`, urgency: "urgent" });
    assert.equal(r.decision.route, "now");
  }
  const seventh = await broker.routeSend({ msgId: randomUUID(), from: codexParty("drouterep3", "rep3"), to: codexTarget("drouteboss3", "boss3"), body: "urgent item 6", urgency: "urgent" });
  assert.equal(seventh.decision.route, "pause");
  assert.equal(seventh.decision.rule, "receiver-budget");
});

test("routing: the binding still routes when the driver is offline", async () => {
  broker.store.updateThread("droutedriver", { state: "ended" });
  const r = await broker.routeSend({ msgId: randomUUID(), from: codexParty("droutestranger", "stranger"), to: codexTarget("drouteworker", "worker"), body: "still just information", urgency: "normal" });
  assert.equal(r.decision.rule, "not-from-driver", "offline driver changes nothing: the worker's earlier question still earns a pause, anything else a digest");
  assert.match(deliveryNote(r, "normal"), new RegExp(`works for ${broker.store.getThread("droutedriver")!.name}`));
});
