import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, sleep, until, fakeClaude, livePid } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer, postLines } from "../src/ccsocks.ts";
import { encodeAddress, userFrame } from "../src/envelope.ts";
import { namespacedSocketPath, threadSocketPath } from "../src/paths.ts";
import { sendMessage } from "../src/send.ts";
import type { Me } from "../src/peers.ts";
import type { Classifier } from "../src/classifier.ts";

const down = join(root, "codex-down");
const attempts = join(root, "attempts.log");
const stub = join(root, "flaky-codex.sh");
writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${attempts}\n[ -e ${down} ] && { echo "app-server unreachable" >&2; exit 1; }\nexit 0\n`);
chmodSync(stub, 0o755);

let classifierCalls = 0;
const classifier: Classifier = {
  name: "counting",
  remote: false,
  threshold: 0.6,
  timeoutMs: 500,
  async classify() {
    classifierCalls++;
    return { route: "pause", confidence: 0.9 };
  },
};
const broker = new Broker({ codexBin: stub, ttyScan: () => [], classifier: () => classifier });
const sender = (name: string): Me => ({ kind: "claude", name, socketPath: join(root, "cc-socks", `${name}.sock`), session: `${name}-session` });
const wakes = () => (existsSync(attempts) ? readFileSync(attempts, "utf8").split("\n").filter((l) => l.startsWith("queue")).length : 0);
const auditEvents = (event: string) => (existsSync(join(process.env.AGENTSOCKS_STATE_DIR!, "audit.log")) ? readFileSync(join(process.env.AGENTSOCKS_STATE_DIR!, "audit.log"), "utf8").split("\n").filter((l) => l.includes(`"event":"${event}"`)) : []);
const idleThread = async (id: string) => {
  await broker.hook({ threadId: id, event: "SessionStart", cwd: `/work/${id}` });
  await broker.hook({ threadId: id, event: "Stop" });
};
const unread = (threadId: string, from: string, body: string, id: string) =>
  broker.store.enqueue({ id, msg_id: id, to_thread: threadId, kind: "message", from_addr: encodeAddress(`${root}/cc-socks/${from}.sock`), from_name: from, from_kind: "claude", from_session: null, from_mode: null, body, received_at: Date.now(), route: "now", decision: null });

before(async () => {
  writeFileSync(down, "");
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("failed wakes back off from 30 s doubling to 10 min and never use up the hourly cap", async () => {
  await idleThread("thread-fail");
  unread("thread-fail", "ann", "hello", "w-1");
  const T = Date.now() + 10_000;
  const outcome = async (at: number) => {
    const before = wakes();
    await broker.wake("thread-fail", at);
    return wakes() - before;
  };
  assert.equal(await outcome(T), 1, "the first attempt goes out");
  assert.equal(await outcome(T + 10_000), 0, "inside the 30 s backoff nothing is attempted");
  assert.equal(await outcome(T + 31_000), 1, "after 30 s it tries again");
  assert.equal(await outcome(T + 31_000 + 59_000), 0, "the second failure waits 60 s");
  assert.equal(await outcome(T + 31_000 + 61_000), 1);
  let at = T + 31_000 + 61_000;
  for (let step = 0; step < 6; step++) {
    at += 11 * 60_000;
    assert.equal(await outcome(at), 1, "from the fifth failure on, one attempt per ten minutes");
  }
  assert.equal(JSON.parse(broker.store.getThread("thread-fail")!.wake_log).length, 0, "a failed wake is not a wake");
  assert.equal(auditEvents("wake_failed").length, wakes(), "one audit line per attempt, not one per sweep");

  rmSync(down);
  at += 11 * 60_000;
  assert.equal(await outcome(at), 1, "once Codex is back the wake goes out even after all those failures");
  assert.equal(JSON.parse(broker.store.getThread("thread-fail")!.wake_log).length, 1, "and only that one counts");
});

test("the hourly cap is reported once, not on every sweep", async () => {
  writeFileSync(down, "");
  rmSync(down);
  await idleThread("thread-cap");
  unread("thread-cap", "ann", "capped", "cap-1");
  const now = Date.now();
  broker.store.updateThread("thread-cap", { wake_log: JSON.stringify(Array.from({ length: 6 }, (_, i) => now - i * 60_000)) });
  const before = wakes();
  for (let i = 0; i < 5; i++) await broker.wake("thread-cap", now + i * 1000);
  assert.equal(wakes(), before, "six wakes in the last hour: no more");
  assert.equal(auditEvents("wake_skipped").filter((l) => l.includes("thread-cap")).length, 1);
});

test("a digest never wakes an idle thread; it waits for the thread's next turn or a read", async () => {
  await idleThread("thread-digest");
  const before = wakes();
  const fyi = await sendMessage(sender("dig"), "codex-thread-digest", "FYI the cache was rebuilt", undefined, { urgency: "fyi" });
  assert.equal(fyi.route, "digest");
  await broker.runSweep();
  assert.equal(broker.store.queuedCount("thread-digest"), 1, "released to the idle thread");
  await sleep(1900);
  assert.equal(wakes(), before, "but nobody woke it");
  assert.ok(broker.take("thread-digest").text.includes("the cache was rebuilt"));
});

test("urgent messages and awaited replies wake an idle thread even when the hourly cap is used up", async () => {
  await idleThread("thread-urgent");
  const capped = () => broker.store.updateThread("thread-urgent", { wake_log: JSON.stringify(Array.from({ length: 6 }, (_, i) => Date.now() - i * 60_000)), pending_wake_at: null });
  capped();
  const before = wakes();
  await sendMessage(sender("ann"), "codex-thread-urgent", "an ordinary message");
  await sleep(1900);
  assert.equal(wakes(), before, "an ordinary wake is held back by the cap");

  broker.store.db.prepare("UPDATE messages SET wakes = 2 WHERE to_thread = 'thread-urgent'").run();
  capped();
  await sendMessage(sender("ann"), "codex-thread-urgent", "ROLL BACK now", undefined, { urgency: "urgent" });
  await until(() => wakes() === before + 1, 4000);
  assert.equal(JSON.parse(broker.store.getThread("thread-urgent")!.wake_log).length, 6, "an exempt wake does not use the cap either");

  await broker.hook({ threadId: "thread-reply", event: "SessionStart", cwd: "/work/reply" });
  await broker.hook({ threadId: "thread-reply", event: "UserPromptSubmit", prompt: "working" });
  const claude = await fakeClaude("replier", livePid(), "idle");
  try {
    const { codexIdentity } = await import("../src/peers.ts");
    await sendMessage(await codexIdentity("thread-reply"), "replier", "which port should I use?");
    for (const n of ["b1", "b2", "b3"]) await sendMessage(sender(n), "codex-reply", `interrupt ${n}`);
    await postLines(threadSocketPath("thread-reply"), [JSON.stringify(userFrame({ from: encodeAddress(claude.socketPath), fromName: "replier", body: "port 8080" }, "reply-1"))]);
    await until(() => broker.store.db.prepare("SELECT 1 FROM messages WHERE msg_id = 'reply-1'").get());
    const rule = (broker.store.db.prepare("SELECT json_extract(decision, '$.rule') AS rule FROM messages WHERE msg_id = 'reply-1'").get() as { rule: string }).rule;
    assert.equal(rule, "awaited-reply");
    broker.store.db.prepare("UPDATE messages SET wakes = 2 WHERE to_thread = 'thread-reply' AND msg_id != 'reply-1'").run();
    await broker.hook({ threadId: "thread-reply", event: "Stop" });
    await broker.hook({ threadId: "thread-reply", event: "Stop" });
    broker.store.updateThread("thread-reply", { state: "idle", wake_log: JSON.stringify(Array.from({ length: 6 }, (_, i) => Date.now() - i * 60_000)), pending_wake_at: null });
    const mark = wakes();
    await broker.wake("thread-reply");
    assert.equal(wakes(), mark + 1, "the awaited reply is exempt from the cap");
  } finally {
    await closeServer(claude.server);
  }
});

test("two sessions answering each other stop waking the thread after 20 exempt wakes an hour, on top of the ordinary six", async () => {
  const T = "thread-pingpong";
  await broker.register(T, { cwd: "/work/pingpong" });
  const info = broker.describe(broker.store.getThread(T)!);
  const claude = await fakeClaude("pingpong", livePid(), "idle");
  try {
    const toCodex = { kind: "codex", addr: encodeAddress(info.socketPath), name: info.name, threadId: T };
    const toClaude = { kind: "claude", addr: encodeAddress(claude.socketPath), name: "pingpong", sessionId: claude.sessionId };
    const claudeParty = { kind: "claude", name: "pingpong", addr: encodeAddress(claude.socketPath), session: claude.sessionId, mode: null };
    const codexParty = { kind: "codex", name: info.name, addr: encodeAddress(info.socketPath), session: T, mode: null };
    const mark = wakes();
    const base = Date.now();
    await broker.hook({ threadId: T, event: "UserPromptSubmit", prompt: "start" });
    for (let round = 0; round < 30; round++) {
      await broker.hook({ threadId: T, event: "Stop" });
      await broker.routeSend({ from: claudeParty, to: toCodex, body: `claude turn ${round}, what do you think?`, urgency: "normal" });
      await broker.wake(T, base + round * 1000);
      broker.take(T);
      await broker.hook({ threadId: T, event: "UserPromptSubmit", prompt: "📨 agentsocks: wake" });
      await broker.routeSend({ from: codexParty, to: toClaude, body: `codex turn ${round}, I think so`, urgency: "normal" });
    }
    const thread = broker.store.getThread(T)!;
    assert.equal(JSON.parse(thread.exempt_wake_log).length, 20, "awaited replies stop at their own cap");
    assert.equal(JSON.parse(thread.wake_log).length, 1, "and never touch the ordinary six: only the opening message counted there");
    assert.equal(wakes() - mark, 21, "30 rounds produced the first wake plus 20 exempt ones, not 30");
    assert.equal(auditEvents("wake_skipped").filter((l) => l.includes(T) && l.includes("urgent and awaited")).length, 1, "the stop is reported once");
  } finally {
    await closeServer(claude.server);
  }
});

test("the exempt cap counts the last hour only, and an ordinary wake is not held back by a full exempt cap", async () => {
  const full = (age: number) => JSON.stringify(Array.from({ length: 20 }, (_, i) => Date.now() - age - i * 1000));
  const wakesAfter = async (thread: string) => {
    broker.store.db.prepare("UPDATE messages SET wakes = 0 WHERE to_thread = ?").run(thread);
    broker.store.updateThread(thread, { pending_wake_at: null });
    const mark = wakes();
    await broker.wake(thread);
    return wakes() - mark;
  };
  await idleThread("thread-exw");
  await sendMessage(sender("ann"), "codex-thread-exw", "ROLL BACK now", undefined, { urgency: "urgent" });
  broker.store.updateThread("thread-exw", { exempt_wake_log: full(5 * 60_000) });
  assert.equal(await wakesAfter("thread-exw"), 0, "20 exempt wakes in the last hour: no more");
  broker.store.updateThread("thread-exw", { exempt_wake_log: full(61 * 60_000) });
  assert.equal(await wakesAfter("thread-exw"), 1, "wakes older than an hour no longer count");

  await idleThread("thread-exw2");
  await sendMessage(sender("bob"), "codex-thread-exw2", "an ordinary message");
  broker.store.updateThread("thread-exw2", { exempt_wake_log: full(5 * 60_000) });
  assert.equal(await wakesAfter("thread-exw2"), 1, "the exempt cap does not touch ordinary wakes");
});

test("with the kill switch on, an inbound frame costs no classifier call and schedules no wake", async () => {
  await idleThread("thread-off");
  broker.store.updateThread("thread-off", { state: "busy" });
  const calls = classifierCalls;
  const mark = wakes();
  process.env.AGENTSOCKS_OFF = "1";
  try {
    await postLines(threadSocketPath("thread-off"), [JSON.stringify(userFrame({ from: encodeAddress(`${root}/cc-socks/ghost.sock`), fromName: "probe", body: "hello while the kill switch is ON" }, "off-1"))]);
    await until(() => broker.store.db.prepare("SELECT 1 FROM messages WHERE msg_id = 'off-1'").get());
    broker.store.updateThread("thread-off", { state: "idle" });
    await broker.runSweep();
    await sleep(1900);
    assert.equal(classifierCalls, calls, "no message text left for the classifier");
    assert.equal(wakes(), mark, "and nothing was woken");
  } finally {
    delete process.env.AGENTSOCKS_OFF;
  }
});

test("a namespaced bind that cannot succeed is logged once per thread and retried with backoff, not on every sweep", async () => {
  const saved = process.env.AGENTSOCKS_CCSOCKS_DIR;
  const dir = join(root, "cc-socks-blocked");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  process.env.AGENTSOCKS_CCSOCKS_DIR = dir;
  try {
    for (let i = 0; i < 3; i++) writeFileSync(namespacedSocketPath(`th-blocked-${i}`)!, "not a socket");
    const logPath = join(process.env.AGENTSOCKS_STATE_DIR!, "daemon.log");
    const before = existsSync(logPath) ? statSync(logPath).size : 0;
    for (let i = 0; i < 3; i++) await broker.register(`th-blocked-${i}`, { cwd: "/w", state: "idle" });
    for (let i = 0; i < 10; i++) await broker.runSweep();
    const lines = (existsSync(logPath) ? readFileSync(logPath, "utf8") : "").slice(before).split("\n").filter((l) => l.includes("namespaced inbox"));
    const threads = lines.map((l) => l.match(/inbox for (\S+) not bound/)![1]);
    assert.equal(new Set(threads).size, threads.length, "no thread is logged twice, however many sweeps ran");
    for (let i = 0; i < 3; i++) assert.ok(threads.includes(`th-blocked-${i}`));
  } finally {
    process.env.AGENTSOCKS_CCSOCKS_DIR = saved;
  }
});
