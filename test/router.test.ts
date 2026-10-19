import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, decideByRules, RECEIVER_NOW_BUDGET, SENDER_BUDGET, URGENT_NOW_BUDGET, type BudgetView, type MessageView, type ReceiverView } from "../src/router.ts";
import type { Classifier, ClassifierInput, ClassifierResult } from "../src/classifier.ts";
import { GITHUB_PAT_LOWER } from "./fakes.ts";

const receiver = (over: Partial<ReceiverView> = {}): ReceiverView => ({ kind: "codex", state: "busy", currentTask: "refactoring auth", lastTool: "Edit", awaitingReplyFromSender: false, ...over });
const message = (over: Partial<MessageView> = {}): MessageView => ({ body: "hello", urgency: "normal", duplicateOfRecent: false, ...over });
const budget = (over: Partial<BudgetView> = {}): BudgetView => ({ receiverNowLast10m: 0, senderToReceiverLast10m: 0, ...over });

function fake(over: Partial<Classifier> & { answer?: () => Promise<ClassifierResult> } = {}): Classifier & { calls: ClassifierInput[]; aborted: boolean } {
  const state = { calls: [] as ClassifierInput[], aborted: false };
  const { answer, ...rest } = over;
  return Object.assign(state, {
    name: "fake",
    remote: false,
    threshold: 0.6,
    timeoutMs: 1000,
    classify(input: ClassifierInput, signal: AbortSignal) {
      state.calls.push(input);
      signal.addEventListener("abort", () => (state.aborted = true));
      return answer ? answer() : Promise.resolve<ClassifierResult>({ route: "now", confidence: 0.9 });
    },
    ...rest,
  });
}

test("rules fire in the documented order, first match wins", () => {
  const cases: { name: string; r?: Partial<ReceiverView>; m?: Partial<MessageView>; b?: Partial<BudgetView>; route: string; by: string; rule: string }[] = [
    { name: "duplicate beats the sender budget", m: { duplicateOfRecent: true }, b: { senderToReceiverLast10m: 50 }, route: "merge", by: "rule", rule: "duplicate" },
    { name: "duplicate beats an idle receiver", r: { state: "idle" }, m: { duplicateOfRecent: true }, route: "merge", by: "rule", rule: "duplicate" },
    { name: "duplicate beats an urgent flag when the first copy was already delivered", m: { duplicateOfRecent: true, urgency: "urgent" }, route: "merge", by: "rule", rule: "duplicate" },
    { name: "sender budget batches a normal message", b: { senderToReceiverLast10m: SENDER_BUDGET }, route: "digest", by: "budget", rule: "sender-budget" },
    { name: "sender budget beats an idle receiver", r: { state: "idle" }, b: { senderToReceiverLast10m: SENDER_BUDGET }, route: "digest", by: "budget", rule: "sender-budget" },
    { name: "urgent bypasses the sender budget", m: { urgency: "urgent" }, b: { senderToReceiverLast10m: SENDER_BUDGET }, route: "now", by: "rule", rule: "urgent" },
    { name: "an awaited reply bypasses the sender budget", r: { awaitingReplyFromSender: true }, b: { senderToReceiverLast10m: SENDER_BUDGET }, route: "now", by: "rule", rule: "awaited-reply" },
    { name: "fyi beats an idle receiver", r: { state: "idle" }, m: { urgency: "fyi" }, route: "digest", by: "rule", rule: "fyi" },
    { name: "an idle receiver gets it now", r: { state: "idle" }, route: "now", by: "rule", rule: "receiver-idle" },
    { name: "an idle receiver is not budget limited", r: { state: "idle" }, b: { receiverNowLast10m: 99 }, route: "now", by: "rule", rule: "receiver-idle" },
    { name: "an awaited reply goes now even over the receiver budget", r: { awaitingReplyFromSender: true }, b: { receiverNowLast10m: 99 }, route: "now", by: "rule", rule: "awaited-reply" },
    { name: "urgent within budget interrupts", m: { urgency: "urgent" }, b: { receiverNowLast10m: URGENT_NOW_BUDGET - 1 }, route: "now", by: "rule", rule: "urgent" },
    { name: "urgent over its larger budget pauses", m: { urgency: "urgent" }, b: { receiverNowLast10m: URGENT_NOW_BUDGET }, route: "pause", by: "budget", rule: "receiver-budget" },
  ];
  for (const c of cases) {
    const d = decideByRules(receiver(c.r), message(c.m), budget(c.b));
    assert.ok(d, c.name);
    assert.deepEqual([d.route, d.by, d.rule], [c.route, c.by, c.rule], c.name);
  }
});

test("budget boundaries: nine messages from a sender are fine, ten are batched; urgent interrupts up to six times, a normal grey-zone message up to three", async () => {
  assert.equal(decideByRules(receiver(), message(), budget({ senderToReceiverLast10m: SENDER_BUDGET - 1 })), undefined);
  assert.equal(decideByRules(receiver(), message(), budget({ senderToReceiverLast10m: SENDER_BUDGET }))?.route, "digest");
  assert.equal(decideByRules(receiver(), message({ urgency: "urgent" }), budget({ receiverNowLast10m: URGENT_NOW_BUDGET - 1 }))?.route, "now");
  assert.equal(decideByRules(receiver(), message({ urgency: "urgent" }), budget({ receiverNowLast10m: URGENT_NOW_BUDGET }))?.route, "pause");
  assert.equal((await decide(receiver(), message(), budget({ receiverNowLast10m: RECEIVER_NOW_BUDGET - 1 }))).route, "now");
  assert.equal((await decide(receiver(), message(), budget({ receiverNowLast10m: RECEIVER_NOW_BUDGET }))).route, "pause");
});

test("a busy or waiting receiver with a normal message is the grey zone: no rule decides", () => {
  assert.equal(decideByRules(receiver({ state: "busy" }), message(), budget()), undefined);
  assert.equal(decideByRules(receiver({ state: "waiting" }), message(), budget()), undefined);
});

test("an unknown receiver is not exempt from the budget: only an idle one is", async () => {
  assert.equal(decideByRules(receiver({ state: "unknown" }), message(), budget()), undefined);
  assert.equal((await decide(receiver({ state: "unknown" }), message(), budget())).route, "now");
  const over = await decide(receiver({ state: "unknown" }), message(), budget({ receiverNowLast10m: RECEIVER_NOW_BUDGET }));
  assert.deepEqual([over.route, over.by, over.rule], ["pause", "budget", "receiver-budget"]);
});

test("with no classifier the grey zone is delivered now, the receiver budget turns it into pause, and nothing calls a classifier when a rule decides", async () => {
  const d = await decide(receiver(), message(), budget());
  assert.deepEqual([d.route, d.by], ["now", "default"]);
  const over = await decide(receiver(), message(), budget({ receiverNowLast10m: RECEIVER_NOW_BUDGET }));
  assert.deepEqual([over.route, over.by, over.rule], ["pause", "budget", "receiver-budget"]);
  const spy = fake();
  const ruled = await decide(receiver({ state: "idle" }), message(), budget(), spy);
  assert.equal(ruled.route, "now");
  const merged = await decide(receiver(), message({ duplicateOfRecent: true }), budget(), spy);
  assert.equal(merged.route, "merge");
  const flooded = await decide(receiver(), message(), budget({ senderToReceiverLast10m: SENDER_BUDGET }), spy);
  assert.equal(flooded.route, "digest");
  assert.equal(spy.calls.length, 0, "a classifier can never override merge, a budget or a rule");
});

test("a duplicate of a message that is still waiting escalates it when the new copy outranks it, and merges when it does not", async () => {
  const waitingDigest = message({ duplicateOfRecent: true, duplicateOfPending: "digest", urgency: "urgent" });
  const escalated = await decide(receiver(), waitingDigest, budget());
  assert.deepEqual([escalated.route, escalated.escalates], ["now", true]);
  assert.match(escalated.reason, /repeats the same text that was still waiting\.$/);
  const waitingPause = message({ duplicateOfRecent: true, duplicateOfPending: "pause" });
  assert.equal((await decide(receiver(), waitingPause, budget())).escalates, true, "a grey-zone repeat goes now once the budget allows it");
  const stillOver = await decide(receiver(), waitingPause, budget({ receiverNowLast10m: RECEIVER_NOW_BUDGET }));
  assert.deepEqual([stillOver.route, stillOver.escalates], ["merge", undefined], "paused again is no better than the paused original");
  const sameFyi = await decide(receiver(), message({ duplicateOfRecent: true, duplicateOfPending: "digest", urgency: "fyi" }), budget());
  assert.equal(sameFyi.route, "merge");
  const settled = await decide(receiver(), message({ duplicateOfRecent: true, urgency: "urgent" }), budget());
  assert.equal(settled.route, "merge", "a copy of something already delivered never escalates");
});

test("a confident classifier answer decides the grey zone and records its confidence, backend and latency", async () => {
  const spy = fake({ answer: () => Promise.resolve({ route: "digest", confidence: 0.83 }) });
  let t = 1000;
  const d = await decide(receiver(), message({ body: "FYI thanks" }), budget(), spy, () => (t += 40));
  assert.equal(d.route, "digest");
  assert.equal(d.by, "classifier");
  assert.equal(d.confidence, 0.83);
  assert.equal(d.backend, "fake");
  assert.equal(d.latencyMs, 40);
  assert.deepEqual(spy.calls[0], { receiverKind: "codex", receiverTask: "refactoring auth", receiverLastTool: "Edit", message: "FYI thanks" });
});

test("below the confidence threshold, on failure, on timeout and on a malformed answer the grey zone falls back to the default and says why", async () => {
  const unsure = await decide(receiver(), message(), budget(), fake({ answer: () => Promise.resolve({ route: "pause", confidence: 0.4 }) }));
  assert.deepEqual([unsure.route, unsure.by, unsure.confidence], ["now", "default", 0.4]);
  assert.match(unsure.reason, /unsure/);

  const broken = await decide(receiver(), message(), budget(), fake({ answer: () => Promise.reject(new Error("connect ECONNREFUSED")) }));
  assert.deepEqual([broken.route, broken.by], ["now", "default"]);
  assert.match(broken.reason, /failed/);

  const hang = fake({ timeoutMs: 40, answer: () => new Promise<ClassifierResult>(() => {}) });
  const slow = await decide(receiver(), message(), budget(), hang);
  assert.deepEqual([slow.route, slow.by], ["now", "default"]);
  assert.match(slow.reason, /timed out after 40 ms/);
  assert.equal(hang.aborted, true, "the request is aborted when the budget runs out");

  for (const garbage of [{ route: "explode", confidence: 0.9 }, { route: "now", confidence: 7 }, { route: "now", confidence: Number.NaN }, undefined]) {
    const bad = await decide(receiver(), message(), budget(), fake({ answer: () => Promise.resolve(garbage as unknown as ClassifierResult) }));
    assert.deepEqual([bad.route, bad.by], ["now", "default"], JSON.stringify(garbage));
  }

  const overBudget = await decide(receiver(), message(), budget({ receiverNowLast10m: RECEIVER_NOW_BUDGET }), fake({ answer: () => Promise.reject(new Error("down")) }));
  assert.deepEqual([overBudget.route, overBudget.by], ["pause", "budget"], "the fallback is still subject to the receiver budget");
});

test("a classifier that answers pause or digest with confidence is obeyed", async () => {
  assert.equal((await decide(receiver(), message(), budget(), fake({ answer: () => Promise.resolve({ route: "pause", confidence: 0.9 }) }))).route, "pause");
  assert.equal((await decide(receiver(), message(), budget(), fake({ answer: () => Promise.resolve({ route: "digest", confidence: 0.9 }) }))).route, "digest");
});

test("the classifier is shown the receiver's task and the message with secrets redacted", async () => {
  const spy = fake();
  await decide(receiver({ currentTask: `deploy with token ${GITHUB_PAT_LOWER}` }), message({ body: "use password=hunter2 for staging" }), budget(), spy);
  assert.equal(spy.calls[0]!.receiverTask, "deploy with token [redacted]");
  assert.equal(spy.calls[0]!.message, "use password=[redacted] for staging");
});

test("a classifier asking for now is still held to the receiver's interrupt budget", async () => {
  const wantsNow = fake({ answer: () => Promise.resolve({ route: "now", confidence: 0.95 }) });
  const within = await decide(receiver(), message(), budget({ receiverNowLast10m: RECEIVER_NOW_BUDGET - 1 }), wantsNow);
  assert.equal(within.route, "now");
  const over = await decide(receiver(), message(), budget({ receiverNowLast10m: RECEIVER_NOW_BUDGET }), wantsNow);
  assert.deepEqual([over.route, over.by, over.rule], ["pause", "budget", "receiver-budget"]);
});

test("every decision explains itself in one sentence", async () => {
  const classifier = fake();
  const decisions = await Promise.all([
    decide(receiver(), message({ duplicateOfRecent: true }), budget()),
    decide(receiver(), message(), budget({ senderToReceiverLast10m: 10 })),
    decide(receiver(), message({ urgency: "fyi" }), budget()),
    decide(receiver({ state: "idle" }), message(), budget()),
    decide(receiver({ state: "unknown" }), message(), budget()),
    decide(receiver({ awaitingReplyFromSender: true }), message(), budget()),
    decide(receiver(), message({ urgency: "urgent" }), budget()),
    decide(receiver(), message({ urgency: "urgent" }), budget({ receiverNowLast10m: 7 })),
    decide(receiver(), message(), budget()),
    decide(receiver(), message(), budget({ receiverNowLast10m: 5 })),
    decide(receiver(), message(), budget(), classifier),
    decide(receiver(), message(), budget({ receiverNowLast10m: 5 }), classifier),
    decide(receiver(), message({ duplicateOfRecent: true, duplicateOfPending: "digest", urgency: "urgent" }), budget()),
  ]);
  for (const d of decisions) {
    assert.ok(d.reason.length > 20, d.reason);
    assert.ok(d.reason.endsWith("."), d.reason);
    assert.equal(d.reason.split(/[.!?] /).length, 1, `one sentence: ${d.reason}`);
    assert.ok(!d.reason.includes("\n"));
  }
});
