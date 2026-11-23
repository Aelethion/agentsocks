import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Broker, type HookRequest, type HookResult } from "../src/broker.ts";
import { hermesAgent } from "../src/agents/hermes.ts";
import { NO_PLUGIN } from "../src/agents/hermes/wake.ts";
import { encodeAddress } from "../src/envelope.ts";
import { root } from "./support.ts";

// No plugin file exists in this process's Hermes home, as for a daemon started without the user's HERMES_HOME.
const SINK = "hermes-0123456789abcdef";
const LINE = "📨 agentsocks: new message from a Claude Code session. Read it with read_inbox.";
const broker = new Broker({ ttyScan: () => [], agents: [hermesAgent] });
const via = (req: HookRequest): Promise<HookResult> => broker.hook(req);
const run = (event: string, input: Record<string, unknown>) => hermesAgent.hook({ event, input, call: via });

let n = 0;
const chat = (): string => {
  const raw = `20261123_2${String(++n).padStart(5, "0")}_gate${n}`;
  broker.store.upsertThread(`hermes_${raw}`, { agent: "hermes", state: "idle" }, "hermes-chat");
  const id = `m-${raw}`;
  broker.store.enqueue({ id, msg_id: id, to_thread: `hermes_${raw}`, kind: "message", from_addr: encodeAddress(`${root}/cc-socks/ann.sock`), from_name: "ann", from_kind: "claude", from_session: null, from_mode: null, body: "hello", received_at: Date.now(), route: "now", decision: null });
  return raw;
};
const failures = (raw: string): string[] => {
  const file = join(process.env.AGENTSOCKS_STATE_DIR!, "audit.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"event":"wake_failed"') && l.includes(`hermes_${raw}`)) : [];
};

before(async () => {
  await broker.start();
});
after(async () => {
  await broker.stop();
});

test("a chat attached to a polling sink is woken even when this process sees no plugin file in its own Hermes home", async () => {
  const raw = chat();
  await run("attach", { session: raw, sink: SINK });
  await run("wake", { sink: SINK, timeoutMs: 0 });
  await broker.wake(`hermes_${raw}`, Date.now() + 5000);
  assert.equal(await run("wake", { sink: SINK, timeoutMs: 0 }), JSON.stringify({ wakes: [{ session: raw, line: LINE }] }));
  assert.deepEqual(failures(raw), []);
});

test("a chat with no sink and no API records one wake_failed and backs off instead of retrying", async () => {
  const raw = chat();
  const at = Date.now() + 5000;
  await broker.wake(`hermes_${raw}`, at);
  assert.equal(failures(raw).length, 1);
  assert.ok(failures(raw)[0]!.includes(NO_PLUGIN));
  for (const later of [1, 100, 1000]) await broker.wake(`hermes_${raw}`, at + later);
  assert.equal(failures(raw).length, 1, "inside the backoff no further attempt is made");
  assert.equal(broker.store.getThread(`hermes_${raw}`)!.pending_wake_at, null);
  await broker.wake(`hermes_${raw}`, at + 3_600_000);
  assert.equal(failures(raw).length, 2, "after the backoff it tries once more");
  assert.match(failures(raw)[1]!, /"attempt":2/);
});
