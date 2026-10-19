import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Broker } from "../src/broker.ts";
import { opencodeAgent } from "../src/agents/opencode.ts";
import { DEFAULT_POLL_MS, FORGET_AFTER_MS, LISTEN_WINDOW_MS, MAX_POLL_MS, pollLimit, sinkOf } from "../src/agents/opencode/sink.ts";
import type { Conn } from "../src/brokerops/types.ts";
import { encodeAddress } from "../src/envelope.ts";
import { root, sleep } from "./support.ts";

const broker = new Broker({ ttyScan: () => [], agents: [opencodeAgent], wakeEnabled: false });

const conn = (): Conn & { close(): void } => {
  let closed = false;
  const listeners: (() => void)[] = [];
  return {
    isClosed: () => closed,
    onClose: (fn) => void listeners.push(fn),
    close: () => {
      closed = true;
      for (const fn of listeners) fn();
    },
  };
};

type Wakes = { wakes: { session: string; line: string }[] };
const poll = async (sink: string, timeoutMs: number, c: Conn = conn()): Promise<Wakes> => (await broker.dispatch({ op: "opencode_wake_wait", sink, timeoutMs }, c)).result as Wakes;
const thread = (session: string) => broker.store.getThread(`opencode_${session}`)!;
const register = async (session: string, sink: string | undefined) => {
  await broker.hook({ threadId: `opencode_${session}`, agent: "opencode", event: "SessionStart", cwd: `/work/${session}`, ...(sink && { remote: sink }) });
  await broker.hook({ threadId: `opencode_${session}`, agent: "opencode", event: "Stop" });
};
const wake = (session: string, line = "📨 agentsocks: new message from a Claude Code session. Read it with agentsocks_read_inbox.") => opencodeAgent.wake!({ broker, thread: thread(session), line });
const audits = (event: string) => {
  const file = join(process.env.AGENTSOCKS_STATE_DIR!, "audit.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.includes(`"event":"${event}"`)) : [];
};
const unread = (session: string, id: string) =>
  broker.store.enqueue({ id, msg_id: id, to_thread: `opencode_${session}`, kind: "message", from_addr: encodeAddress(`${root}/cc-socks/ann.sock`), from_name: "ann", from_kind: "claude", from_session: null, from_mode: null, body: "please look at the diff", received_at: Date.now(), route: "now", decision: null });

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("a poll with nothing to deliver returns an empty list when its time is up", async () => {
  const started = Date.now();
  assert.deepEqual(await poll("sink-quiet-1", 150), { wakes: [] });
  assert.ok(Date.now() - started >= 140, "it waited for its time");
});

test("a wake that arrives while the plugin is polling ends that poll at once, with the session and the content-free line", async () => {
  await register("ses_live", "sink-live-01");
  const pending = poll("sink-live-01", 5000);
  await sleep(30);
  const started = Date.now();
  assert.deepEqual(await wake("ses_live"), { ok: true });
  assert.deepEqual(await pending, { wakes: [{ session: "ses_live", line: "📨 agentsocks: new message from a Claude Code session. Read it with agentsocks_read_inbox." }] });
  assert.ok(Date.now() - started < 1000, "the poll did not wait out its time");
});

test("a wake between two polls waits for the next one, and the wake is refused once the plugin has been silent for longer than the window", async () => {
  await register("ses_gap", "sink-gap-001");
  assert.deepEqual(await poll("sink-gap-001", 20), { wakes: [] });
  assert.deepEqual(await wake("ses_gap"), { ok: true }, "polled a moment ago, so it is listening");
  const next = Date.now();
  assert.deepEqual((await poll("sink-gap-001", 5000)).wakes.map((w) => w.session), ["ses_gap"]);
  assert.ok(Date.now() - next < 500, "the queued wake came back at once");

  sinkOf(broker, "sink-gap-001")!.seenAt = Date.now() - LISTEN_WINDOW_MS - 1000;
  assert.deepEqual(await wake("ses_gap"), { ok: false, detail: "no plugin is listening for this session" });
  sinkOf(broker, "sink-gap-001")!.seenAt = Date.now() - LISTEN_WINDOW_MS + 5000;
  assert.deepEqual(await wake("ses_gap"), { ok: true });
});

test("a session whose plugin never polled, was never told its sink, or whose sink is unknown cannot be woken", async () => {
  await register("ses_unknown", "sink-never-1");
  assert.deepEqual(await wake("ses_unknown"), { ok: false, detail: "no plugin is listening for this session" });
  await register("ses_nosink", undefined);
  assert.deepEqual(await wake("ses_nosink"), { ok: false, detail: "no plugin is listening for this session" });
});

test("two wakes for one session leave one in the queue, the newest", async () => {
  await register("ses_dup", "sink-dup-001");
  await poll("sink-dup-001", 10);
  await wake("ses_dup", "📨 agentsocks: first");
  await wake("ses_dup", "📨 agentsocks: second");
  assert.deepEqual((await poll("sink-dup-001", 100)).wakes, [{ session: "ses_dup", line: "📨 agentsocks: second" }]);
});

test("a wake queued for a session that ended in the meantime is dropped instead of delivered", async () => {
  await register("ses_gone", "sink-gone-01");
  await register("ses_stays", "sink-gone-01");
  await poll("sink-gone-01", 10);
  await wake("ses_gone");
  await wake("ses_stays");
  await broker.hook({ threadId: "opencode_ses_gone", agent: "opencode", event: "SessionEnd" });
  assert.deepEqual((await poll("sink-gone-01", 100)).wakes.map((w) => w.session), ["ses_stays"]);
});

test("a newer poll from the same plugin ends an older one that is still waiting, and keeps the queue for itself", async () => {
  await register("ses_two", "sink-two-001");
  const older = poll("sink-two-001", 5000);
  await sleep(20);
  const newer = poll("sink-two-001", 5000);
  assert.deepEqual(await older, { wakes: [] });
  await sleep(20);
  await wake("ses_two");
  assert.deepEqual((await newer).wakes.map((w) => w.session), ["ses_two"]);
});

test("a poll whose connection closed stops waiting, and the plugin counts as listening only for the window after that", async () => {
  await register("ses_drop", "sink-drop-01");
  const c = conn();
  const pending = poll("sink-drop-01", 5000, c);
  await sleep(20);
  assert.equal(sinkOf(broker, "sink-drop-01")!.waiting !== undefined, true);
  c.close();
  assert.deepEqual(await pending, { wakes: [] });
  assert.equal(sinkOf(broker, "sink-drop-01")!.waiting, undefined);
  assert.deepEqual(await wake("ses_drop"), { ok: true }, "just polled, so a wake queues for the next poll");
});

test("a sink nobody has polled for ten minutes is forgotten, and one with a wake still queued is kept", async () => {
  await poll("sink-old-0001", 10);
  await register("ses_keep", "sink-keep-001");
  await poll("sink-keep-001", 10);
  await wake("ses_keep");
  sinkOf(broker, "sink-old-0001")!.seenAt = Date.now() - FORGET_AFTER_MS - 1000;
  sinkOf(broker, "sink-keep-001")!.seenAt = Date.now() - FORGET_AFTER_MS - 1000;
  await poll("sink-trigger-1", 10);
  assert.equal(sinkOf(broker, "sink-old-0001"), undefined);
  assert.notEqual(sinkOf(broker, "sink-keep-001"), undefined);
});

test("a poll with a sink id that is not one is refused, and a timeout above the broker's limit is cut to it", async () => {
  for (const bad of [undefined, "", "short", "has space in it", "x".repeat(65), 7, "../../etc/passwd"]) {
    await assert.rejects(broker.dispatch({ op: "opencode_wake_wait", sink: bad, timeoutMs: 10 }, conn()), /sink id/, String(bad));
  }
  assert.equal(pollLimit(10 ** 9), MAX_POLL_MS);
  assert.equal(pollLimit(-5), 0);
  assert.equal(pollLimit(Number.NaN), DEFAULT_POLL_MS);
  assert.equal(pollLimit("60000"), DEFAULT_POLL_MS);
  assert.equal(pollLimit(1234), 1234);
});

test("the broker counts a wake that reached a listening plugin like any other, and backs off from one that did not", async () => {
  await register("ses_acct", "sink-acct-01");
  unread("ses_acct", "acct-1");
  await poll("sink-acct-01", 10);
  await broker.wake("opencode_ses_acct", Date.now() + 5000);
  assert.equal(JSON.parse(thread("ses_acct").wake_log).length, 1);
  assert.equal(audits("wake").filter((l) => l.includes("opencode_ses_acct")).length, 1);

  await register("ses_cold", "sink-cold-01");
  unread("ses_cold", "cold-1");
  const at = Date.now() + 5000;
  await broker.wake("opencode_ses_cold", at);
  await broker.wake("opencode_ses_cold", at + 10_000);
  assert.equal(JSON.parse(thread("ses_cold").wake_log).length, 0, "a refused wake is not counted");
  assert.equal(audits("wake_failed").filter((l) => l.includes("opencode_ses_cold")).length, 1, "and inside the backoff it is not tried again");
  assert.match(audits("wake_failed").filter((l) => l.includes("opencode_ses_cold"))[0] ?? "", /no plugin is listening for this session/);
});
