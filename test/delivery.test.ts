import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root, sleep, until, fakeClaude, inTranscript, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer, postLines } from "../src/ccsocks.ts";
import { brokerCall } from "../src/client.ts";
import { buildEnvelope, encodeAddress, messageContent, parseEnvelope, userFrame } from "../src/envelope.ts";
import { codexIdentity, type Me } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";
import { threadSocketPath } from "../src/paths.ts";
import type { Classifier } from "../src/classifier.ts";
import type { RouteSendResult } from "../src/routing.ts";
import type { OutboxRow } from "../src/store.ts";
import { tempDir } from "./tmp.ts";

let classifierImpl: Classifier | undefined;
const broker = new Broker({ classifier: () => classifierImpl, wakeEnabled: false });
const outbox = (msgId: string): OutboxRow => broker.store.getOutbox(msgId)!;
const sender = (name: string): Me => ({ kind: "claude", name, socketPath: join(root, "cc-socks", `${name}.sock`), session: `${name}-session` });
const party = (name: string) => ({ kind: "claude", name, addr: encodeAddress(join(root, "cc-socks", `${name}.sock`)), session: null, mode: null });
const partyOf = (c: FakeClaude) => ({ kind: "claude", name: c.name, addr: encodeAddress(c.socketPath), session: c.sessionId, mode: null });
const claudeTarget = (c: FakeClaude, addr = c.socketPath) => ({ kind: "claude", addr: encodeAddress(addr), name: c.name, sessionId: c.sessionId });
const codexTarget = (threadId: string, name: string) => ({ kind: "codex", addr: encodeAddress(threadSocketPath(threadId)), name, threadId });
const route = (raw: Record<string, unknown>) => broker.routeSend(raw);
const bodiesOf = (c: FakeClaude): string[] => c.frames.map((f) => parseEnvelope(messageContent(f))!.body);

const fakeClassifier = (classify: Classifier["classify"], over: Partial<Classifier> = {}): Classifier => ({ name: "fake", remote: false, threshold: 0.6, timeoutMs: 1500, classify, ...over });

before(async () => {
  await broker.start();
});

after(async () => {
  classifierImpl = undefined;
  await broker.stop();
});

test("a slow classifier never turns a send into a duplicate direct post", async () => {
  const alpha = await fakeClaude("slowalpha", livePid(), "busy");
  classifierImpl = fakeClassifier(async () => {
    await sleep(1400);
    return { route: "pause", confidence: 0.9 };
  });
  try {
    const me = sender("ann");
    const results = await Promise.all(Array.from({ length: 7 }, (_, i) => sendMessage(me, "slowalpha", `distinct message ${i}`)));
    await sleep(400);
    assert.ok(results.every((r) => !/posted straight/.test(r.note)), "every send went through the broker");
    const bodies = bodiesOf(alpha).sort();
    assert.deepEqual(bodies, Array.from({ length: 7 }, (_, i) => `distinct message ${i}`).sort(), "each message reaches the receiver exactly once");
  } finally {
    classifierImpl = undefined;
    await closeServer(alpha.server);
  }
});

test("a broker that takes the request and then goes quiet is outcome unknown, and the message is not posted a second time", async () => {
  const alpha = await fakeClaude("quietalpha", livePid(), "idle");
  const dir = tempDir("agentsocks-quiet-");
  const quiet = createServer((s) => s.on("data", () => s.destroy()));
  await new Promise<void>((r) => quiet.listen(join(dir, "broker.sock"), () => r()));
  const saved = process.env.AGENTSOCKS_RUNTIME_DIR;
  process.env.AGENTSOCKS_RUNTIME_DIR = dir;
  try {
    await assert.rejects(sendMessage(sender("ann"), "quietalpha", "maybe delivered"), /did not answer in time\. The message may already be delivered; check with message_status [0-9a-f-]{36} before resending\./);
    await sleep(200);
    assert.equal(alpha.frames.length, 0, "no direct post behind the broker's back");
  } finally {
    process.env.AGENTSOCKS_RUNTIME_DIR = saved;
    quiet.close();
    await closeServer(alpha.server);
  }
});

test("route_send is idempotent on the client's message id, and an id cannot be borrowed by another sender", async () => {
  const alpha = await fakeClaude("idemalpha", livePid(), "idle");
  try {
    const req = { msgId: "client-id-1", from: party("ann"), to: claudeTarget(alpha), body: "once only", urgency: "normal" };
    const first = await brokerCall<RouteSendResult>("route_send", req);
    const again = await brokerCall<RouteSendResult>("route_send", req);
    assert.equal(first.msgId, "client-id-1");
    assert.deepEqual([again.msgId, again.status, again.decision.route], [first.msgId, first.status, first.decision.route]);
    await sleep(200);
    assert.equal(alpha.frames.length, 1, "the repeat returned the recorded result without sending again");
    await assert.rejects(brokerCall("route_send", { ...req, from: party("mallory") }), /already used for another message/);
  } finally {
    await closeServer(alpha.server);
  }
});

test("task_create is idempotent on the client's request id", async () => {
  const alpha = await fakeClaude("taskalpha", livePid(), "idle");
  try {
    const req = { requestId: "req-1", from: { ...party("lead"), kind: "codex" }, to: claudeTarget(alpha), title: "Do the thing", body: "details", risk: "low" };
    const first = await brokerCall<{ task: { id: string } }>("task_create", req);
    const again = await brokerCall<{ task: { id: string } }>("task_create", req);
    assert.equal(again.task.id, first.task.id);
    await sleep(200);
    assert.equal(alpha.frames.length, 1, "one assignment message");
    assert.equal(Number((broker.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE request_id = 'req-1'").get() as { n: number }).n), 1);
  } finally {
    await closeServer(alpha.server);
  }
});

test("a flood of inbound frames is limited before any classifier call, and a real message is not stuck behind it", async () => {
  await broker.register("flood-thread", { cwd: "/w/flood", state: "busy" });
  broker.store.updateThread("flood-thread", { state: "busy" });
  let calls = 0;
  let inflight = 0;
  let peak = 0;
  classifierImpl = fakeClassifier(
    (_input, signal) => {
      calls++;
      inflight++;
      peak = Math.max(peak, inflight);
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => {
          inflight--;
          reject(new Error("aborted"));
        }),
      );
    },
    { timeoutMs: 200 },
  );
  try {
    const post = (i: number, body: string, id: string) =>
      postLines(threadSocketPath("flood-thread"), [JSON.stringify(userFrame({ from: encodeAddress(`/tmp/attacker/${i}.sock`), fromName: `attacker-${i}`, body }, id))]);
    for (let i = 0; i < 50; i++) await post(i, `spam ${i}`, `spam-${i}`);
    const started = Date.now();
    await post(900, "a real message", "legit-1");
    await until(() => broker.store.db.prepare("SELECT 1 FROM messages WHERE msg_id = 'legit-1'").get(), 3000);
    assert.ok(Date.now() - started < 1500, `the real message waited ${Date.now() - started} ms`);
    assert.ok(peak <= 4, `at most four classifier calls at a time, saw ${peak}`);
    assert.ok(calls <= 60, `classifier calls are bounded by the limiter, saw ${calls}`);
  } finally {
    classifierImpl = undefined;
  }
});

test("no more than twenty decisions queue for one receiver", async () => {
  const internal = broker as unknown as { serialized<T>(key: string, fn: () => Promise<T> | T, max?: number): Promise<T> };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const running = Array.from({ length: 20 }, () => internal.serialized("one-receiver", () => gate, 20));
  await assert.rejects(internal.serialized("one-receiver", () => 1, 20), /too many messages to this session/);
  release();
  await Promise.all(running);
  assert.equal(await internal.serialized("one-receiver", () => "drained", 20), "drained");
});

test("the same text re-sent as urgent while the first copy is still a held digest escalates it instead of merging", async () => {
  const alpha = await fakeClaude("escalpha", livePid(), "busy");
  try {
    const to = claudeTarget(alpha);
    const first = await route({ from: party("ann"), to, body: "deploy 41 is failing health checks", urgency: "fyi" });
    const second = await route({ from: party("ann"), to, body: "deploy 41 is failing health checks", urgency: "urgent" });
    assert.equal(first.decision.route, "digest");
    assert.deepEqual([second.decision.route, second.decision.escalates], ["now", true]);
    await until(() => alpha.frames.length === 1);
    assert.equal(alpha.frames[0]!.priority, "next");
    assert.equal(outbox(first.msgId).status, "merged");
    assert.match(outbox(first.msgId).error!, /superseded/);
    alpha.setStatus("idle");
    await broker.runSweep();
    await sleep(150);
    assert.equal(alpha.frames.length, 1, "the superseded digest is never flushed");
    const again = await route({ from: party("ann"), to, body: "deploy 41 is failing health checks", urgency: "urgent" });
    assert.equal(again.decision.route, "merge", "a copy of something already delivered still merges");
  } finally {
    await closeServer(alpha.server);
  }
});

test("urgent and awaited-reply messages bypass the sender budget", async () => {
  const alpha = await fakeClaude("budgetalpha", livePid(), "busy");
  try {
    const to = claudeTarget(alpha);
    for (let i = 0; i < 10; i++) await route({ from: party("bob"), to, body: `status ${i}`, urgency: "normal" });
    const flooded = await route({ from: party("bob"), to, body: "one more status", urgency: "normal" });
    assert.equal(flooded.decision.rule, "sender-budget");
    const urgent = await route({ from: party("bob"), to, body: "ROLL BACK NOW, the migration is corrupting rows", urgency: "urgent" });
    assert.deepEqual([urgent.decision.route, urgent.decision.rule], ["now", "urgent"], "an urgent message is never held in a digest by the sender budget, and urgent has a larger interrupt budget");
    await until(() => bodiesOf(alpha).includes("ROLL BACK NOW, the migration is corrupting rows"));
  } finally {
    await closeServer(alpha.server);
  }
});

test("a paused Codex message that is re-sent as urgent is replaced in the inbox, not duplicated", async () => {
  await broker.hook({ threadId: "thread-esc", event: "SessionStart", cwd: "/work/esc" });
  await broker.hook({ threadId: "thread-esc", event: "UserPromptSubmit", prompt: "a long task" });
  classifierImpl = fakeClassifier(async () => ({ route: "pause", confidence: 0.9 }));
  const to = codexTarget("thread-esc", "codex-esc");
  const first = await route({ from: party("ann"), to, body: "please double check the migration", urgency: "normal" });
  classifierImpl = undefined;
  assert.equal(first.decision.route, "pause");
  const second = await route({ from: party("ann"), to, body: "please double check the migration", urgency: "urgent" });
  assert.deepEqual([second.decision.route, second.decision.escalates], ["now", true]);
  const rows = broker.store.db.prepare("SELECT msg_id, route FROM messages WHERE to_thread = 'thread-esc' AND kind = 'message'").all() as { msg_id: string; route: string }[];
  assert.deepEqual(rows.map((r) => [r.msg_id, r.route]), [[second.msgId, "now"]]);
  assert.equal(outbox(first.msgId).status, "merged");
});

test("an aliased address cannot dodge the budgets", async () => {
  const alpha = await fakeClaude("aliasalpha", livePid(), "busy");
  try {
    const routes: string[] = [];
    for (let i = 0; i < 12; i++) {
      const alias = i % 2 === 0 ? alpha.socketPath : alpha.socketPath.replace("/cc-socks/", `/cc-socks/${"./".repeat(i + 1)}`);
      routes.push((await route({ from: party("eve"), to: claudeTarget(alpha, alias), body: `aliased ${i}`, urgency: "normal" })).decision.route);
    }
    assert.deepEqual(routes, [...Array(3).fill("now"), ...Array(7).fill("pause"), "digest", "digest"], "the budgets saw one receiver and one sender throughout");
    assert.equal(new Set((broker.store.db.prepare("SELECT to_addr FROM outbox WHERE to_name = 'aliasalpha'").all() as { to_addr: string }[]).map((r) => r.to_addr)).size, 1);
    const viaTool = await sendMessage(sender("zoe"), `uds:${alpha.socketPath.replace("/cc-socks/", "/cc-socks/./")}`, "by an aliased address");
    assert.equal(viaTool.route, "pause", "the tool path lands on the same receiver budget");
  } finally {
    await closeServer(alpha.server);
  }
});

test("a receiver whose state is unknown is not exempt from the receiver budget", async () => {
  const mystery = await fakeClaude("mystery", livePid(), undefined);
  try {
    const routes: string[] = [];
    for (let i = 0; i < 5; i++) routes.push((await route({ from: party("fay"), to: claudeTarget(mystery), body: `unknown state ${i}`, urgency: "normal" })).decision.route);
    assert.deepEqual(routes, ["now", "now", "now", "pause", "pause"]);
  } finally {
    await closeServer(mystery.server);
  }
});

test("a Codex thread parked in wait_for_message counts as idle and gets its digests at once", async () => {
  await broker.hook({ threadId: "thread-wait", event: "SessionStart", cwd: "/work/wait" });
  await broker.hook({ threadId: "thread-wait", event: "UserPromptSubmit", prompt: "waiting on a peer" });
  const waiting = brokerCall<{ text: string }>("wait", { threadId: "thread-wait", timeoutMs: 5000 }, { timeoutMs: 8000, autoStart: false });
  await sleep(150);
  const fyi = await sendMessage(sender("gus"), "codex-wait", "FYI the build is green", undefined, { urgency: "fyi" });
  assert.equal(fyi.route, "digest");
  const got = await waiting;
  assert.ok(got.text.includes("FYI the build is green"), "the waiting thread was handed its digest");
  await until(() => outbox(fyi.msgId).status === "shown");

  const second = brokerCall<{ text: string }>("wait", { threadId: "thread-wait", timeoutMs: 5000 }, { timeoutMs: 8000, autoStart: false });
  await sleep(150);
  const normal = await sendMessage(sender("gus"), "codex-wait", "a normal message while you wait");
  assert.equal(JSON.parse(outbox(normal.msgId).decision).rule, "receiver-idle");
  assert.ok((await second).text.includes("a normal message while you wait"));
});

test("reading the inbox releases the reader's held digests, from the tool and from the shell command alike", async () => {
  await broker.hook({ threadId: "thread-read", event: "SessionStart", cwd: "/work/read" });
  await broker.hook({ threadId: "thread-read", event: "UserPromptSubmit", prompt: "busy" });
  const fyi = await sendMessage(sender("hal"), "codex-read", "FYI for a reader", undefined, { urgency: "fyi" });
  assert.equal(outbox(fyi.msgId).status, "held");
  const r = await brokerCall<{ text: string }>("take", { threadId: "thread-read", via: "shell" }, { autoStart: false });
  assert.ok(r.text.includes("FYI for a reader"));
  await until(() => outbox(fyi.msgId).status === "shown");
});

test("only a recent now or pause message from the receiver makes the sender's answer an awaited reply", async () => {
  const askerA = await fakeClaude("asker", livePid(), "idle");
  await broker.hook({ threadId: "thread-aw", event: "SessionStart", cwd: "/work/aw" });
  await broker.hook({ threadId: "thread-aw", event: "UserPromptSubmit", prompt: "busy with a task" });
  try {
    const codex = await codexIdentity("thread-aw");
    for (const name of ["x1", "x2", "x3"]) await route({ from: party(name), to: codexTarget("thread-aw", "codex-aw"), body: `interrupt from ${name}`, urgency: "normal" });
    const askerMe: Me = { kind: "claude", name: "asker", socketPath: askerA.socketPath, session: askerA.sessionId };

    await sendMessage(codex, "asker", "FYI nothing to answer here", undefined, { urgency: "fyi" });
    await broker.runSweep();
    const notAwaited = await sendMessage(askerMe, "codex-aw", "replying to a digest");
    assert.equal(notAwaited.route, "pause", "an fyi from the receiver is not a question: the receiver budget applies");

    const question = await sendMessage(codex, "asker", "which version should I use?");
    assert.equal(question.route, "now");
    const answer = await sendMessage(askerMe, "codex-aw", "version 7");
    const decision = JSON.parse(outbox(answer.msgId).decision);
    assert.deepEqual([answer.route, decision.rule], ["now", "awaited-reply"]);
    assert.doesNotMatch(decision.reason, /asked a question/);
  } finally {
    await closeServer(askerA.server);
  }
});

test("an unrelated message from the receiver does not mark anything shown or replied; a reply to a message already shown does", async () => {
  const ann = await fakeClaude("honestann", livePid(), "busy");
  const bea = await fakeClaude("honestbea", livePid(), "busy");
  try {
    const m1 = await route({ from: partyOf(ann), to: claudeTarget(bea), body: "please review PR 12 before you finish", urgency: "normal" });
    await route({ from: partyOf(bea), to: claudeTarget(ann), body: "unrelated: lunch at noon?", urgency: "fyi" });
    const unseen = outbox(m1.msgId);
    assert.deepEqual([unseen.status, unseen.shown_at, unseen.replied_at], ["sent", null, null], "nothing was observed, so nothing is claimed");

    const m2 = await route({ from: partyOf(ann), to: claudeTarget(bea), body: "and the docs too", urgency: "normal" });
    inTranscript(bea, m2.msgId);
    await broker.runSweep();
    assert.equal(outbox(m2.msgId).status, "shown");
    const shownAt = outbox(m2.msgId).shown_at;
    await route({ from: partyOf(bea), to: claudeTarget(ann), body: "docs are done", urgency: "normal" });
    const replied = outbox(m2.msgId);
    assert.deepEqual([replied.status, replied.shown_at], ["replied", shownAt], "the reply keeps the observed shown time");
    assert.equal(outbox(m1.msgId).status, "sent", "and the unseen one is still unseen");
  } finally {
    await closeServer(ann.server);
    await closeServer(bea.server);
  }
});

test("evicting a held digest from a full Codex inbox marks its outbox row failed", async () => {
  await broker.register("thread-full", { cwd: "/w/full" });
  broker.store.updateThread("thread-full", { state: "busy" });
  const to = codexTarget("thread-full", "codex-full");
  const first = await route({ from: party("ann"), to, body: "FYI: build finished at 10:02", urgency: "fyi" });
  assert.equal(outbox(first.msgId).status, "held");
  for (let i = 0; i < 199; i++) {
    broker.store.enqueue({ id: `f${i}`, msg_id: `fm${i}`, to_thread: "thread-full", kind: "message", from_addr: "uds:/x/y.sock", from_name: "x", from_kind: "claude", from_session: null, from_mode: null, body: `filler ${i}`, received_at: Date.now() + i, route: "digest", decision: null, held: true });
  }
  await route({ from: party("ann"), to, body: "please look at the failing test", urgency: "normal" });
  const evicted = outbox(first.msgId);
  assert.equal(evicted.status, "failed");
  assert.match(evicted.error!, /dropped: receiver inbox full/);
});

test("route_send is rate limited per sender and receiver for Claude targets too, and bodies are not kept once delivered", async () => {
  const alpha = await fakeClaude("limitalpha", livePid(), "idle");
  try {
    const to = claudeTarget(alpha);
    const results = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => route({ from: party("rapid"), to, body: `rapid ${i}`, urgency: "normal" })));
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.ok(refused.length >= 9, `a sender gets a burst of 30, saw ${refused.length} refusals`);
    assert.match(String(refused[0]!.reason), /too many messages to this session/);
    const sent = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<RouteSendResult>;
    const row = outbox(sent.value.msgId);
    assert.equal(row.body, "", "the text is dropped once it has been posted");
    assert.equal(row.body_chars! > 0, true);
    assert.ok(row.body_hash);
    const held = await route({ from: party("patient"), to, body: "FYI keep me until flushed", urgency: "fyi" });
    assert.equal(outbox(held.msgId).body, "FYI keep me until flushed", "a held digest keeps its text until it is flushed");
    await broker.runSweep();
    await until(() => outbox(held.msgId).status === "sent");
    assert.equal(outbox(held.msgId).body, "");
  } finally {
    await closeServer(alpha.server);
  }
});

test("deciding reads hashes, not stored message text", () => {
  const rows = broker.store.recentOutboxTo("uds:/nowhere", 0);
  assert.deepEqual(rows, []);
  broker.store.insertOutbox({
    id: "x8", msg_id: "x8", from_addr: "uds:/a", from_name: "a", from_kind: "claude", from_session: null, from_mode: null, to_addr: "uds:/b", to_name: "b", to_kind: "claude", to_thread: null, to_session: null,
    body: "SECRET text of the message", urgency: "normal", route: "pause", decision: "{}", status: "sent", task_id: null, created_at: Date.now(),
  });
  const [seen] = broker.store.recentOutboxTo("uds:/b", 0);
  assert.ok(seen && !JSON.stringify(seen).includes("SECRET"));
  assert.match(seen!.body_hash!, /^[0-9a-f]{64}$/);
});

test("a flushed digest carries the same advertised sender address as the sender's direct message, even after the sender's session ended", async () => {
  const alpha = await fakeClaude("addralpha", livePid(), "idle");
  await broker.hook({ threadId: "thread-addr", event: "SessionStart", cwd: "/work/addr" });
  try {
    const me = await codexIdentity("thread-addr");
    await sendMessage(me, "addralpha", "a direct message");
    alpha.setStatus("busy");
    await sendMessage(me, "addralpha", "FYI a digest", undefined, { urgency: "fyi" });
    await broker.hook({ threadId: "thread-addr", event: "SessionEnd" });
    alpha.setStatus("idle");
    await broker.runSweep();
    await until(() => alpha.frames.length === 2);
    const [direct, digest] = alpha.frames.map((f) => parseEnvelope(messageContent(f))!);
    assert.equal(direct!.from, encodeAddress(me.socketPath!));
    assert.match(direct!.from!, /cc-socks\/a[0-9a-f]{15}\.sock$/);
    assert.equal(digest!.from, direct!.from, "Claude can reply to the digest's sender exactly as to its direct message");
    assert.equal((alpha.frames[1] as { from?: string }).from, direct!.from);
  } finally {
    await closeServer(alpha.server);
  }
});

test("the merge rule covers raw inbound frames, so the v0.1 30 second duplicate drop is not needed", async () => {
  await broker.hook({ threadId: "thread-dup", event: "SessionStart", cwd: "/work/dup" });
  await broker.hook({ threadId: "thread-dup", event: "UserPromptSubmit", prompt: "busy" });
  const raw = (id: string, body: string) =>
    postLines(threadSocketPath("thread-dup"), [JSON.stringify({ type: "user", message: { role: "user", content: buildEnvelope({ from: encodeAddress(join(root, "cc-socks", "dupsender.sock")), fromName: "dupsender", body }) }, msg_id: id })]);
  await raw("dup-1", "please   rebase onto main");
  await until(() => broker.store.queuedCount("thread-dup") === 1);
  await raw("dup-2", "please rebase\nonto main");
  await raw("dup-3", "a different request");
  await until(() => broker.store.queuedCount("thread-dup") === 2);
  await sleep(150);
  assert.equal(broker.store.queuedCount("thread-dup"), 2, "the repeat with other whitespace and another message id was merged");
  const merges = existsSync(join(process.env.AGENTSOCKS_STATE_DIR!, "audit.log")) ? readFileSync(join(process.env.AGENTSOCKS_STATE_DIR!, "audit.log"), "utf8").split("\n").filter((l) => l.includes('"event":"merge"') && l.includes("dup-2")) : [];
  assert.equal(merges.length, 1);
  assert.equal(broker.store.db.prepare("SELECT 1 FROM messages WHERE msg_id = 'dup-2'").get(), undefined);
});

test("concurrent grey-zone messages cannot jointly exceed the receiver budget, and concurrent identical urgent copies deliver once", async () => {
  const alpha = await fakeClaude("racealpha", livePid(), "busy");
  try {
    const to = claudeTarget(alpha);
    classifierImpl = fakeClassifier(async () => {
      await sleep(100);
      return { route: "now", confidence: 0.95 };
    });
    const eight = await Promise.all(Array.from({ length: 8 }, (_, i) => route({ from: party(`racer${i}`), to, body: `classifier-now candidate ${i}`, urgency: "normal" })));
    classifierImpl = undefined;
    const routes = eight.map((r) => r.decision.route);
    assert.equal(routes.filter((r) => r === "now").length, 3, `the classifier said now eight times at once, the budget still holds: ${routes.join(" ")}`);
    assert.equal(routes.filter((r) => r === "pause").length, 5);
    const copies = await Promise.all([1, 2, 3].map(() => route({ from: party("zed"), to, body: "identical", urgency: "urgent" })));
    assert.deepEqual(copies.map((r) => r.decision.route).sort(), ["merge", "merge", "now"]);
  } finally {
    classifierImpl = undefined;
    await closeServer(alpha.server);
  }
});
