import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { until, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress, messageContent, parseEnvelope } from "../src/envelope.ts";
import { codexIdentity, listPeers, RESOLVABLE, type Me } from "../src/peers.ts";
import { pickBest } from "../src/pick.ts";
import { refOf } from "../src/channels.ts";
import { threadSocketPath } from "../src/paths.ts";
import { answerAsk, askSessions } from "../src/askclient.ts";
import { formatAsk } from "../src/asks.ts";
import { subscribeTo, unsubscribeFrom } from "../src/channelclient.ts";
import { cat } from "./fakes.ts";
import type { Classifier, ChooseInput, ChooseResult } from "../src/classifier.ts";
import { SWEEP_STAGES } from "../src/sweep/index.ts";
import { AskService, type AskSnapshot } from "../src/asks.ts";
import { brokerCall } from "../src/client.ts";

let classifierImpl: Classifier | undefined;
const broker = new Broker({ wakeEnabled: false, classifier: () => classifierImpl });
let ops: FakeClaude;
let docs: FakeClaude;
let orchestrator: Me;
let builder: Me;
let tester: Me;

const claudeMe = (c: FakeClaude): Me => ({ kind: "claude", name: c.name, socketPath: c.socketPath, session: c.sessionId });
const askIds = (): string[] => (broker.store.db.prepare("SELECT id FROM asks ORDER BY created_at, rowid").all() as { id: string }[]).map((r) => r.id);
const newAsk = async (before: number): Promise<string> => until(() => askIds()[before]);
const inbox = (threadId: string): string => broker.take(threadId).text;
const bodiesOf = (c: FakeClaude): string[] => c.frames.map((f) => parseEnvelope(messageContent(f))!.body);

const chooser = (answer: (input: ChooseInput) => ChooseResult | Promise<ChooseResult>, over: Partial<Classifier> = {}): { classifier: Classifier; seen: ChooseInput[] } => {
  const seen: ChooseInput[] = [];
  const classifier: Classifier = {
    name: "fake",
    remote: false,
    threshold: 0.5,
    timeoutMs: 300,
    classify: async () => ({ route: "now", confidence: 0.9 }),
    choose: async (input) => {
      seen.push(input);
      return answer(input);
    },
    ...over,
  };
  return { classifier, seen };
};

before(async () => {
  await broker.start();
  ops = await fakeClaude("ops", process.pid, "idle");
  docs = await fakeClaude("docs", livePid(), "idle");
  for (const t of ["orchestrator", "builder", "tester"]) await broker.hook({ threadId: `thread-${t}`, event: "SessionStart", cwd: `/work/${t}` });
  orchestrator = await codexIdentity("thread-orchestrator");
  builder = await codexIdentity("thread-builder");
  tester = await codexIdentity("thread-tester");
});

after(async () => {
  await closeServer(ops.server);
  await closeServer(docs.server);
  await broker.stop();
});

test("an ask reaches each named session as its own routed message with the ask id, and returns every answer together as soon as the last one is in", async () => {
  const count = askIds().length;
  const started = Date.now();
  const pending = askSessions(orchestrator, { to: [builder.name, tester.name, "ops"], question: "which branch is the release cut from?", timeoutSeconds: 30 });
  const id = await newAsk(count);
  assert.match(id, /^A-[0-9a-f]{6}$/);
  await until(() => bodiesOf(ops).some((b) => b.includes(id)));
  const toBuilder = inbox("thread-builder");
  assert.match(toBuilder, new RegExp(`\\[agentsocks ask ${id}\\] @${orchestrator.name} asks`));
  assert.match(toBuilder, /which branch is the release cut from\?/);
  assert.match(toBuilder, new RegExp(`arrive through the agentsocks answer tool with ask_id "${id}"`));
  const sentTo = broker.store.db.prepare("SELECT to_name, route FROM outbox WHERE body_chars > 0 AND task_id IS NULL AND msg_id LIKE ? ORDER BY to_name").all(`${id}:%`) as { to_name: string; route: string }[];
  assert.equal(sentTo.length, 3, "three deliveries, each with its own outbox row and routing decision");
  await answerAsk(builder, id, "release/2.4");
  await answerAsk(claudeMe(ops), id, "release/2.4, cut yesterday");
  await answerAsk(tester, id, "main");
  const outcome = await pending;
  assert.ok(Date.now() - started < 10_000, "returned on the last answer, not at the timeout");
  assert.equal(outcome.ask.complete, true);
  assert.deepEqual(outcome.ask.targets.map((t) => [t.name, t.state, t.answer]), [
    [builder.name, "answered", "release/2.4"],
    [tester.name, "answered", "main"],
    ["ops", "answered", "release/2.4, cut yesterday"],
  ]);
  const text = formatAsk(outcome);
  assert.match(text, new RegExp(`Ask ${id}: 3 sessions asked, 3 answered`));
  for (const answer of ["release/2.4", "main", "release/2.4, cut yesterday"]) assert.ok(text.includes(answer));
});

test("a session that does not answer in time is reported as such, and the ask closes so a late answer is refused with what to do instead", async () => {
  const count = askIds().length;
  const pending = askSessions(orchestrator, { to: [builder.name, tester.name], question: "any blockers?", timeoutSeconds: 2 });
  const id = await newAsk(count);
  await answerAsk(tester, id, "none");
  const outcome = await pending;
  assert.equal(outcome.ask.complete, false);
  assert.deepEqual(outcome.ask.targets.map((t) => [t.name, t.state]), [[builder.name, "asked"], [tester.name, "answered"]]);
  const text = formatAsk(outcome);
  assert.match(text, /1 answered/);
  assert.match(text, new RegExp(`No answer from @${builder.name} \\(codex\\) within 2 s`));
  assert.match(text, /An answer sent any other way still reaches you as an ordinary message/);
  await assert.rejects(answerAsk(builder, id, "late"), /has closed \(the asker is no longer waiting\); send your answer with send_message/);
});

test("only a session that was asked can answer, and it can answer once", async () => {
  const count = askIds().length;
  const pending = askSessions(orchestrator, { to: [builder.name], question: "ready?", timeoutSeconds: 5 });
  const id = await newAsk(count);
  await assert.rejects(answerAsk(tester, id, "yes, me too"), /you were not asked/);
  await assert.rejects(answerAsk(builder, "A-ffffff", "yes"), /no ask A-ffffff/);
  await assert.rejects(answerAsk(builder, id, "   "), /answer is empty/);
  await assert.rejects(answerAsk(builder, id, "x".repeat(5000)), /longer than 4000 characters/);
  await answerAsk(builder, id, "yes");
  await assert.rejects(answerAsk(builder, id, "actually no"), /already answered/);
  const outcome = await pending;
  assert.equal(outcome.ask.targets[0]!.answer, "yes");
});

test("asking a channel asks its subscribers except the asker, and the question names no channel members who are the asker", async () => {
  await subscribeTo(builder, "#askroom");
  await subscribeTo(tester, "#askroom");
  await subscribeTo(orchestrator, "#askroom");
  const count = askIds().length;
  const pending = askSessions(orchestrator, { to: ["#askroom"], question: "who owns the flaky test?", timeoutSeconds: 5 });
  const id = await newAsk(count);
  await answerAsk(builder, id, "me");
  await answerAsk(tester, id, "not me");
  const outcome = await pending;
  assert.deepEqual(outcome.ask.targets.map((t) => t.name).sort(), [builder.name, tester.name].sort());
  assert.equal(outcome.ask.complete, true);
  for (const m of [builder, tester, orchestrator]) await unsubscribeFrom(m, "#askroom");
});

test("a Claude asker cannot ask a Claude session through agentsocks: that one is skipped and named, the Codex one is asked", async () => {
  const count = askIds().length;
  const pending = askSessions(claudeMe(ops), { to: ["docs", builder.name], question: "status?", timeoutSeconds: 2 });
  const id = await newAsk(count);
  await answerAsk(builder, id, "green");
  const outcome = await pending;
  assert.deepEqual(outcome.ask.targets.map((t) => [t.name, t.state]), [["docs", "skipped"], [builder.name, "answered"]]);
  assert.equal(outcome.ask.complete, true, "a skipped session is not waited for");
  assert.match(formatAsk(outcome), /Not asked: @docs \(claude\): you are a Claude session, so ask Claude sessions with your built-in SendMessage/);
  assert.equal(docs.frames.length, 0);
});

test("an ask to a session that does not exist is refused before anyone is asked", async () => {
  const count = askIds().length;
  const before = broker.store.db.prepare("SELECT count(*) AS n FROM outbox").get() as { n: number };
  await assert.rejects(askSessions(orchestrator, { to: [builder.name, "nobody-home"], question: "hello?", timeoutSeconds: 1 }), /no running session named "nobody-home"/);
  assert.equal(askIds().length, count);
  assert.deepEqual(broker.store.db.prepare("SELECT count(*) AS n FROM outbox").get(), before);
});

test("an ask needs a question and at most 16 sessions", async () => {
  await assert.rejects(askSessions(orchestrator, { to: [builder.name], question: "  ", timeoutSeconds: 1 }), /question is empty/);
  const many = Array.from({ length: 17 }, (_, i) => `#room-${i}`);
  await assert.rejects(askSessions(orchestrator, { to: many, question: "x?", timeoutSeconds: 1 }), /at most 16 sessions/);
  await assert.rejects(askSessions(orchestrator, { to: [], question: "x?", timeoutSeconds: 1 }), /name at least one session/);
});

test("pick: best shows the model's choice with every probability next to all the replies, and never replaces them", async () => {
  const { classifier, seen } = chooser(() => ({ choice: "r2", confidence: 0.81, probabilities: { r1: 0.12, r2: 0.81, r3: 0.07 } }));
  classifierImpl = classifier;
  const count = askIds().length;
  const pending = askSessions(orchestrator, { to: [builder.name, tester.name, "ops"], question: "how do I roll back?", timeoutSeconds: 5, pick: "best" });
  const id = await newAsk(count);
  await answerAsk(builder, id, "git revert HEAD");
  await answerAsk(tester, id, "run scripts/rollback.sh --to previous, then check /healthz");
  await answerAsk(claudeMe(ops), id, "no idea");
  const outcome = await pending;
  classifierImpl = undefined;
  assert.deepEqual(seen[0]!.options.map((o) => o.id), ["r1", "r2", "r3"]);
  assert.equal(outcome.pick?.status, "picked");
  assert.equal(outcome.pick?.choice, tester.name);
  assert.deepEqual(outcome.pick?.probabilities?.map((p) => [p.name, p.p]), [[builder.name, 0.12], [tester.name, 0.81], ["ops", 0.07]]);
  const text = formatAsk(outcome);
  assert.match(text, new RegExp(`Smart-routing pick \\(fake, on this machine\\): @${tester.name} answers best`));
  assert.match(text, new RegExp(`@${builder.name} 0\\.12, @${tester.name} 0\\.81, @ops 0\\.07`));
  assert.match(text, /not a decision/);
  for (const answer of ["git revert HEAD", "run scripts/rollback.sh", "no idea"]) assert.ok(text.includes(answer), `${answer} is still shown`);
  const stored = JSON.parse((broker.store.db.prepare("SELECT pick_result FROM asks WHERE id = ?").get(id) as { pick_result: string }).pick_result);
  assert.equal(stored.choice, tester.name);
  assert.ok(!JSON.stringify(stored).includes("git revert"), "the stored pick has names and numbers, not the replies");
});

test("pick: best sends the question and replies with secrets redacted and cut, and only when the asker asked for it", async () => {
  const secret = cat("ghp", "_1234567890abcdefghijklmnopqrstuvwxyz12");
  const { classifier, seen } = chooser(() => ({ choice: "r1", confidence: 0.9, probabilities: { r1: 0.9, r2: 0.1 } }));
  classifierImpl = classifier;
  let count = askIds().length;
  let pending = askSessions(orchestrator, { to: [builder.name, tester.name], question: `use ${secret}?`, timeoutSeconds: 5 });
  let id = await newAsk(count);
  await answerAsk(builder, id, "a");
  await answerAsk(tester, id, "b");
  await pending;
  assert.equal(seen.length, 0, "without pick nothing goes to the model");
  count = askIds().length;
  pending = askSessions(orchestrator, { to: [builder.name, tester.name], question: `use ${secret}?`, timeoutSeconds: 5, pick: "best" });
  id = await newAsk(count);
  await answerAsk(builder, id, `token ${secret} then ${"y".repeat(3000)}`);
  await answerAsk(tester, id, "b");
  await pending;
  classifierImpl = undefined;
  const sent = JSON.stringify(seen);
  assert.ok(!sent.includes(secret), "the secret is redacted before it leaves");
  assert.ok(seen[0]!.options[0]!.text.length <= 1500, "each reply is cut");
  assert.ok(seen[0]!.question.length <= 1000);
});

test("pick: best says why there is no pick when there is no model, one reply, too little confidence, a failure or a timeout", async () => {
  const run = async (classifier: Classifier | undefined, answers: string[]) => {
    classifierImpl = classifier;
    const count = askIds().length;
    const who = [builder, tester].slice(0, answers.length);
    const pending = askSessions(orchestrator, { to: who.map((m) => m.name), question: `q${count}?`, timeoutSeconds: 5, pick: "best" });
    const id = await newAsk(count);
    for (const [i, m] of who.entries()) await answerAsk(m, id, answers[i]!);
    const outcome = await pending;
    classifierImpl = undefined;
    return { outcome, text: formatAsk(outcome) };
  };
  const none = await run(undefined, ["a", "b"]);
  assert.equal(none.outcome.pick?.status, "unavailable");
  assert.match(none.text, /no pick was made: smart routing is off \(see `agentsocks classifier`\)/);
  const single = await run(chooser(() => ({ choice: "r1", confidence: 1 })).classifier, ["only"]);
  assert.match(single.text, /no pick was made: there is only one reply/);
  const unsure = await run(chooser(() => ({ choice: "r1", confidence: 0.4, probabilities: { r1: 0.4, r2: 0.35, r3: 0.25 } })).classifier, ["a", "b"]);
  assert.equal(unsure.outcome.pick?.status, "unsure");
  assert.match(unsure.text, /no pick was made: the model was not sure \(confidence 0\.4, below its threshold 0\.5\)/);
  const failing = await run(chooser(() => Promise.reject(new Error("HTTP 500"))).classifier, ["a", "b"]);
  assert.equal(failing.outcome.pick?.status, "failed");
  assert.match(failing.text, /no pick was made: the fake model failed \(HTTP 500\)/);
  const slow = await run(chooser(() => new Promise<ChooseResult>(() => {}), { timeoutMs: 50 }).classifier, ["a", "b"]);
  assert.match(slow.text, /no pick was made: the fake model timed out after 150 ms/, "the choice gets three times the routing timeout, as its prompt is larger");
  const plain = await run({ name: "plain", remote: false, threshold: 0.5, timeoutMs: 100, classify: async () => ({ route: "now", confidence: 1 }) }, ["a", "b"]);
  assert.match(plain.text, /no pick was made: the plain model cannot choose between replies/);
  for (const r of [none, single, unsure, failing, slow, plain]) assert.ok(r.text.includes("Smart-routing pick:") || /no pick was made/.test(r.text), "a requested pick is never silently skipped");
});

test("an ask is refused while the kill switch is on, and the asks the sweep finds expired are closed and old ones are purged", async () => {
  const count = askIds().length;
  const pending = askSessions(orchestrator, { to: [builder.name], question: "sweep me?", timeoutSeconds: 60 });
  const id = await newAsk(count);
  const stage = SWEEP_STAGES.find((s) => s.name === "asks")!;
  assert.ok(stage, "the asks stage is registered");
  await stage.run(broker, Date.now() + 120_000);
  const outcome = await pending;
  assert.equal(outcome.ask.status, "closed");
  assert.equal(outcome.ask.complete, false);
  await stage.run(broker, Date.now() + 15 * 86_400_000);
  assert.equal(broker.store.db.prepare("SELECT 1 FROM asks WHERE id = ?").get(id), undefined);
  assert.equal(broker.store.db.prepare("SELECT 1 FROM ask_targets WHERE ask_id = ?").get(id), undefined);
  process.env.AGENTSOCKS_OFF = "1";
  try {
    await assert.rejects(askSessions(orchestrator, { to: [builder.name], question: "off?", timeoutSeconds: 1 }), /switched off/);
  } finally {
    delete process.env.AGENTSOCKS_OFF;
  }
});

test("pick runs only for an ask made with pick best, once, and a repeated request returns the stored result without asking the model again", async () => {
  const { classifier, seen } = chooser(() => ({ choice: "r1", confidence: 0.9, probabilities: { r1: 0.9, r2: 0.1 } }));
  classifierImpl = classifier;
  const party = (m: Me) => ({ kind: m.kind, name: m.name, addr: `uds:${m.socketPath}`, session: m.session, mode: null });
  let count = askIds().length;
  let pending = askSessions(orchestrator, { to: [builder.name, tester.name], question: "no pick asked?", timeoutSeconds: 5 });
  let id = await newAsk(count);
  await answerAsk(builder, id, "a");
  await answerAsk(tester, id, "b");
  await pending;
  await assert.rejects(brokerCall("ask_pick", { askId: id, party: party(orchestrator) }), /was not made with pick "best", so its replies are not sent to the model/);
  count = askIds().length;
  pending = askSessions(orchestrator, { to: [builder.name, tester.name], question: "pick asked?", timeoutSeconds: 5, pick: "best" });
  id = await newAsk(count);
  await answerAsk(builder, id, "a");
  await answerAsk(tester, id, "b");
  const first = await pending;
  const again = await brokerCall<{ status: string; choice?: string }>("ask_pick", { askId: id, party: party(orchestrator) });
  classifierImpl = undefined;
  assert.equal(seen.length, 1, "the model was asked once");
  assert.deepEqual([again.status, again.choice], [first.pick?.status, first.pick?.choice]);
  await assert.rejects(brokerCall("ask_pick", { askId: id, party: party(builder) }), /no ask .* made by you/, "only the asker");
});

test("a secret that straddles the cut is redacted before the text is cut, so no prefix of it reaches the model", async () => {
  const secret = cat("ghp", "_1234567890abcdefghijklmnopqrstuvwxyz12");
  const { classifier, seen } = chooser(() => ({ choice: "r1", confidence: 0.9, probabilities: { r1: 0.9, r2: 0.1 } }));
  classifierImpl = classifier;
  const count = askIds().length;
  const pending = askSessions(orchestrator, { to: [builder.name, tester.name], question: `${"q".repeat(990)} ${secret}`, timeoutSeconds: 5, pick: "best" });
  const id = await newAsk(count);
  await answerAsk(builder, id, `${"y".repeat(1490)} ${secret}`);
  await answerAsk(tester, id, "b");
  await pending;
  classifierImpl = undefined;
  assert.ok(!JSON.stringify(seen).includes("ghp_"), "not even the start of the token");
});

test("a session whose delivery failed cannot answer, and is told it was never reached; a channel's sessions that are gone are not asked at all", async () => {
  const phantom = { kind: "claude", addr: encodeAddress("/nowhere/phantom.sock"), name: "phantom", sessionId: "phantom-session" };
  const party = (m: Me) => ({ kind: m.kind, name: m.name, addr: encodeAddress(m.socketPath!), session: m.session, mode: null });
  const created = await brokerCall<{ id: string; targets: { name: string; state: string }[] }>("ask_create", {
    from: party(orchestrator),
    targets: [phantom, { kind: "codex", addr: encodeAddress(threadSocketPath(builder.session!)), name: builder.name, threadId: builder.session }],
    channels: [],
    question: "anyone left?",
    timeoutSeconds: 5,
  });
  assert.deepEqual(created.targets.map((t) => [t.name, t.state]), [["phantom", "failed"], [builder.name, "asked"]]);
  await assert.rejects(answerAsk({ kind: "claude", name: "phantom", socketPath: "/nowhere/phantom.sock", session: "phantom-session" }, created.id, "I am here"), /never reached you .*no inbox socket/);
  await answerAsk(builder, created.id, "yes");
  const waited = await brokerCall<AskSnapshot>("ask_wait", { askId: created.id, party: party(orchestrator) });
  assert.equal(waited.complete, true);
  assert.match(formatAsk({ ask: waited }), /Not delivered to @phantom \(claude\): no inbox socket/);

  const gone = await fakeClaude("vanished", livePid(), "idle");
  await subscribeTo(claudeMe(gone), "#vanish");
  await subscribeTo(builder, "#vanish");
  await closeServer(gone.server);
  const count = askIds().length;
  const pending = askSessions(orchestrator, { to: ["#vanish"], question: "anyone left in the channel?", timeoutSeconds: 5 });
  const id = await newAsk(count);
  await answerAsk(builder, id, "me");
  assert.deepEqual((await pending).ask.targets.map((t) => t.name), [builder.name]);
  for (const m of [claudeMe(gone), builder]) await unsubscribeFrom(m, "#vanish");
});

test("asks are rate limited per asker before anything is stored", async () => {
  const limited = new AskService({
    db: broker.store.db,
    send: () => Promise.reject(new Error("must not send")),
    targetOf: () => {
      throw new Error("must not resolve");
    },
    canon: (addr) => addr ?? null,
    holds: () => false,
    expand: () => [],
    mayReach: () => true,
    classifier: () => undefined,
    allow: () => false,
  });
  const before = askIds().length;
  await assert.rejects(
    limited.create({ from: { kind: "cli", name: "looper", addr: null, session: null, mode: null }, targets: [{ kind: "codex", addr: "uds:/x/t/thread-x.sock", name: "x", threadId: "thread-x" }], channels: [], question: "again?", timeoutSeconds: 1 }),
    /too many asks from you just now/,
  );
  assert.equal(askIds().length, before);
});

test("an ask that is open when the broker restarts is closed, so a late answerer is told to use send_message instead of being told it was the last one in", async () => {
  const count = askIds().length;
  const pending = askSessions(orchestrator, { to: [builder.name], question: "restart me?", timeoutSeconds: 30 });
  const settled = pending.then(
    () => "answered",
    (e: Error) => e.message,
  );
  const id = await newAsk(count);
  await until(() => broker.store.db.prepare("SELECT 1 FROM asks WHERE id = ? AND status = 'open'").get(id));
  await until(() => (broker.asks as unknown as { waiters: Map<string, unknown> }).waiters.has(id));
  await broker.stop();
  await broker.start();
  assert.match(await settled, /closed the connection|did not answer|ask_wait/);
  assert.equal((broker.store.db.prepare("SELECT status FROM asks WHERE id = ?").get(id) as { status: string }).status, "closed");
  await assert.rejects(answerAsk(builder, id, "too late"), /has closed \(the asker is no longer waiting\); send your answer with send_message instead/);
});

test("two sessions with one name are told apart by their ref in the answers and in the pick, and an explicit name plus a channel that holds it asks it once", async () => {
  await broker.hook({ threadId: "thread-dup-a", event: "SessionStart", cwd: "/a/dup" });
  await broker.hook({ threadId: "thread-dup-b", event: "SessionStart", cwd: "/b/dup" });
  await brokerCall("set_name", { threadId: "thread-dup-a", name: "codex-dup" });
  await brokerCall("set_name", { threadId: "thread-dup-b", name: "codex-dup" });
  const dupA = await codexIdentity("thread-dup-a");
  const dupB = await codexIdentity("thread-dup-b");
  assert.equal(dupA.name, dupB.name);
  const refs = (await listPeers(RESOLVABLE)).filter((p) => p.name === dupA.name).map((p) => p.ref);
  assert.equal(refs.length, 2);
  const { classifier } = chooser((input) => {
    const best = input.options.find((o) => o.text.includes("answer from B"))!.id;
    return { choice: best, confidence: 0.9, probabilities: Object.fromEntries(input.options.map((o) => [o.id, o.id === best ? 0.9 : 0.1])) };
  });
  classifierImpl = classifier;
  const count = askIds().length;
  const pending = askSessions(orchestrator, { to: refs, question: "which twin?", timeoutSeconds: 5, pick: "best" });
  const id = await newAsk(count);
  await answerAsk(dupA, id, "answer from A");
  await answerAsk(dupB, id, "answer from B");
  const outcome = await pending;
  classifierImpl = undefined;
  const text = formatAsk(outcome);
  const refA = refOf(encodeAddress(threadSocketPath(dupA.session!)));
  const refB = refOf(encodeAddress(threadSocketPath(dupB.session!)));
  assert.notEqual(refA, refB);
  assert.ok(refs.every((r) => r.startsWith(refA) || r.startsWith(refB)), "the ref shown is the one list_peers gives");
  assert.match(text, new RegExp(`@${dupA.name} \\[${refA}\\] \\(codex\\) answered after \\d+ s:\nanswer from A`));
  assert.match(text, new RegExp(`@${dupB.name} \\[${refB}\\] \\(codex\\) answered after \\d+ s:\nanswer from B`));
  assert.match(text, new RegExp(`: @${dupB.name} \\[${refB}\\] answers best\\. Probabilities: `));
  assert.match(text, new RegExp(`@${dupA.name} \\[${refA}\\] 0\\.1`));
  assert.match(text, new RegExp(`@${dupB.name} \\[${refB}\\] 0\\.9`));

  await subscribeTo(builder, "#once-only");
  const next = askIds().length;
  const again = askSessions(orchestrator, { to: [builder.name, "#once-only", "#ONCE-ONLY"], question: "asked once?", timeoutSeconds: 5 });
  const nextId = await newAsk(next);
  await answerAsk(builder, nextId, "yes");
  assert.equal((await again).ask.targets.length, 1);
  await unsubscribeFrom(builder, "#once-only");
});

test("pick says there are no replies when none came in", async () => {
  const { classifier } = chooser(() => ({ choice: "r1", confidence: 1 }));
  assert.match((await pickBest(classifier, "q?", [])).note, /^there are no replies$/);
  assert.match((await pickBest(classifier, "q?", [{ name: "a", ref: "000000", text: "x" }])).note, /^there is only one reply$/);
});

test("two requests for a pick at once ask the model once", async () => {
  let calls = 0;
  const { classifier } = chooser(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { choice: "r1", confidence: 0.9, probabilities: { r1: 0.9, r2: 0.1 } };
  });
  classifierImpl = classifier;
  const party = { kind: orchestrator.kind, name: orchestrator.name, addr: `uds:${orchestrator.socketPath}`, session: orchestrator.session, mode: null };
  const count = askIds().length;
  const pending = askSessions(orchestrator, { to: [builder.name, tester.name], question: "race the pick?", timeoutSeconds: 5 });
  const id = await newAsk(count);
  await answerAsk(builder, id, "a");
  await answerAsk(tester, id, "b");
  await pending;
  broker.store.db.prepare("UPDATE asks SET pick = 'best' WHERE id = ?").run(id);
  const both = await Promise.all([brokerCall("ask_pick", { askId: id, party }), brokerCall("ask_pick", { askId: id, party })]);
  classifierImpl = undefined;
  assert.equal(calls, 1);
  assert.deepEqual(both[0], both[1]);
});
