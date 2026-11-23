import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Broker, type HookRequest, type HookResult } from "../src/broker.ts";
import { hermesAgent } from "../src/agents/hermes.ts";
import { PLUGIN_MARKER } from "../src/agents/hermes/plugin.ts";
import { NO_PLUGIN } from "../src/agents/hermes/wake.ts";
import { encodeAddress } from "../src/envelope.ts";
import { root } from "./support.ts";

const SINK = "hermes-0123456789abcdef";
const OTHER_SINK = "hermes-fedcba9876543210";
const LINE = "📨 agentsocks: new message from a Claude Code session. Read it with read_inbox.";
const BODY = "the deploy key is ZEBRA-PASSWORD-1234";

const broker = new Broker({ ttyScan: () => [], agents: [hermesAgent] });
const via = (req: HookRequest): Promise<HookResult> => broker.hook(req);
const run = (event: string, input: Record<string, unknown>) => hermesAgent.hook({ event, input, call: via });
const thread = (raw: string) => broker.store.getThread(`hermes_${raw}`);
let n = 0;
const session = (): string => `20261123_1${String(++n).padStart(5, "0")}_abc${String(n).padStart(3, "0")}`;
const unread = (raw: string): void => {
  const id = `m-${raw}-${++n}`;
  broker.store.enqueue({ id, msg_id: id, to_thread: `hermes_${raw}`, kind: "message", from_addr: encodeAddress(`${root}/cc-socks/ann.sock`), from_name: "ann", from_kind: "claude", from_session: null, from_mode: null, body: BODY, received_at: Date.now(), route: "now", decision: null });
};
const idle = (raw: string) => broker.store.upsertThread(`hermes_${raw}`, { agent: "hermes", state: "idle" }, "hermes-chat");
const failures = (raw: string): string[] => {
  const file = join(process.env.AGENTSOCKS_STATE_DIR!, "audit.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"event":"wake_failed"') && l.includes(`hermes_${raw}`)) : [];
};

before(async () => {
  const dir = join(homedir(), ".hermes", "plugins", "agentsocks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "__init__.py"), `${PLUGIN_MARKER}\n`);
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("attach ties a chat to the plugin's sink and nothing more: no turn state, no notices taken, no hook bookkeeping", async () => {
  const raw = session();
  unread(raw);
  assert.equal(await run("attach", { session: raw, sink: SINK, cwd: "/work/api" }), JSON.stringify({ attached: true }));
  const t = thread(raw)!;
  assert.equal(t.agent, "hermes");
  assert.equal(t.remote, SINK);
  assert.equal(t.cwd, "/work/api");
  assert.equal(t.state, "unknown");
  assert.notEqual(t.hooks_active, 1);
  assert.equal(broker.store.queuedCount(`hermes_${raw}`), 1, "the waiting message is untouched");
  assert.equal(await run("attach", { session: raw, sink: "bad sink!" }), undefined);
  assert.equal(await run("attach", { session: "../etc", sink: SINK }), undefined);
});

test("a message to an idle chat attached to a polling sink is a wake on that sink for that chat only, not for a sibling chat on the same sink", async () => {
  const chat = session();
  const sibling = session();
  for (const raw of [chat, sibling]) await run("attach", { session: raw, sink: SINK });
  assert.equal(await run("wake", { sink: SINK, timeoutMs: 0 }), JSON.stringify({ wakes: [] }));
  for (const raw of [chat, sibling]) idle(raw);
  unread(chat);
  await broker.wake(`hermes_${chat}`, Date.now() + 5000);
  await broker.wake(`hermes_${sibling}`, Date.now() + 5000);
  assert.equal(await run("wake", { sink: SINK, timeoutMs: 0 }), JSON.stringify({ wakes: [{ session: chat, line: LINE }] }));
  assert.equal(await run("wake", { sink: OTHER_SINK, timeoutMs: 0 }), JSON.stringify({ wakes: [] }));
  assert.equal(broker.store.queuedCount(`hermes_${chat}`), 1, "the message waits in the inbox to be read");
  assert.deepEqual(failures(chat), []);
});

test("a long poll that is already waiting gets the wake as soon as it is offered", async () => {
  const chat = session();
  await run("attach", { session: chat, sink: OTHER_SINK });
  idle(chat);
  const pending = run("wake", { sink: OTHER_SINK, timeoutMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  unread(chat);
  await broker.wake(`hermes_${chat}`, Date.now() + 5000);
  assert.equal(await pending, JSON.stringify({ wakes: [{ session: chat, line: LINE }] }));
});

test("a chat no plugin has attached is not woken: the wake fails naming the missing plugin, and the message still waits in the inbox", async () => {
  const raw = session();
  idle(raw);
  unread(raw);
  await broker.wake(`hermes_${raw}`, Date.now() + 5000);
  const failed = failures(raw);
  assert.equal(failed.length, 1);
  assert.ok(failed[0]!.includes(NO_PLUGIN), failed[0]);
  assert.ok(!failed[0]!.includes("ZEBRA"));
  assert.equal(broker.store.queuedCount(`hermes_${raw}`), 1);
});

test("a chat attached to a sink nobody polls any more is not woken either", async () => {
  const raw = session();
  await run("attach", { session: raw, sink: "hermes-aaaaaaaaaaaaaaaa" });
  idle(raw);
  unread(raw);
  await broker.wake(`hermes_${raw}`, Date.now() + 5000);
  assert.ok(failures(raw)[0]?.includes(NO_PLUGIN));
});

test("the thread list says which chats a polling plugin can wake, which is what doctor reads", async () => {
  const heard = session();
  const deaf = session();
  await run("attach", { session: heard, sink: SINK });
  await run("wake", { sink: SINK, timeoutMs: 0 });
  idle(deaf);
  const list = (await broker.dispatch({ op: "list_threads" })).result as { threadId: string; wakeListening?: boolean }[];
  assert.equal(list.find((t) => t.threadId === `hermes_${heard}`)?.wakeListening, true);
  assert.equal(list.find((t) => t.threadId === `hermes_${deaf}`)?.wakeListening, undefined);
});
