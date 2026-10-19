import { reapPidFile } from "./procs.ts";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Broker } from "../src/broker.ts";
import { opencodeAgent } from "../src/agents/opencode.ts";
import { pluginSource } from "../src/agents/opencode/plugin.ts";
import { sinkOf } from "../src/agents/opencode/sink.ts";
import type { Hooks } from "../src/agents/opencode/runtime.ts";
import { encodeAddress } from "../src/envelope.ts";
import { MAX_EXEMPT_WAKES_PER_HOUR, MAX_WAKES_PER_HOUR, STOP_STREAK_LIMIT } from "../src/limits.ts";
import { root, sleep, until } from "./support.ts";
import { tempDir } from "./tmp.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SHIM = pathToFileURL(fileURLToPath(new URL("./fixtures/agents/opencode/plugin-shim.mjs", import.meta.url))).href;
const events = JSON.parse(readFileSync(new URL("./fixtures/agents/opencode/events.json", import.meta.url), "utf8")) as Record<string, unknown>;
const PREFIX = "📨 agentsocks:";

const broker = new Broker({ ttyScan: () => [], agents: [opencodeAgent], wakeEnabled: false });
const loaded: Hooks[] = [];

interface Prompt {
  path: { id: string };
  body: { parts: { type: string; text: string }[] };
}

const ev = (name: string, session: string): never => JSON.parse(JSON.stringify(events[name]).replaceAll("ses_root0001", session)) as never;

async function load() {
  const prompts: Prompt[] = [];
  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, directory: "/work/api" } }),
      promptAsync: async (options: Prompt) => {
        prompts.push(options);
        return undefined;
      },
    },
  };
  const dir = tempDir("agentsocks-oc-bounds-");
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  const file = join(dir, "agentsocks.js");
  writeFileSync(file, pluginSource({ node: process.execPath, cli: CLI, toolModule: SHIM }));
  const mod = (await import(pathToFileURL(file).href)) as { AgentsocksPlugin: (input: unknown) => Promise<Hooks> };
  const hooks = await mod.AgentsocksPlugin({ client, directory: "/work/api", worktree: "/work/api", project: {}, serverUrl: new URL("http://localhost:4096"), $: undefined });
  loaded.push(hooks);
  return { hooks, prompts };
}

const thread = (session: string) => broker.store.getThread(`opencode_${session}`)!;
const audits = (event: string, needle: string) => {
  const file = join(process.env.AGENTSOCKS_STATE_DIR!, "audit.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.includes(`"event":"${event}"`) && l.includes(needle)) : [];
};
const unread = (session: string, id: string) =>
  broker.store.enqueue({ id, msg_id: id, to_thread: `opencode_${session}`, kind: "message", from_addr: encodeAddress(`${root}/cc-socks/chatty.sock`), from_name: "chatty", from_kind: "claude", from_session: null, from_mode: null, body: `message ${id}`, received_at: Date.now(), route: "now", decision: null });
const party = (session: string) => ({ kind: "codex" as const, agent: "opencode" as const, name: thread(session).name, addr: encodeAddress(broker.describe(thread(session)).socketPath), session: `opencode_${session}`, mode: null });
const target = (session: string) => ({ kind: "codex" as const, addr: encodeAddress(broker.describe(thread(session)).socketPath), name: thread(session).name, threadId: `opencode_${session}` });

async function stopStrayDaemon(): Promise<void> {
  await reapPidFile(process.env.AGENTSOCKS_RUNTIME_DIR!);
}

before(async () => {
  await broker.start();
});

afterEach(async () => {
  for (const hooks of loaded.splice(0)) await hooks.dispose().catch(() => {});
});

after(async () => {
  await broker.stop();
  await stopStrayDaemon();
});

test("a peer that keeps writing cannot keep one session going: the plugin asks for at most the stop limit of extra turns in a row, then lets it go idle", async () => {
  const { hooks, prompts } = await load();
  const S = "ses_chatty001";
  await hooks.event({ event: ev("sessionCreatedRoot", S) });
  await hooks["chat.message"](ev("chatMessageInput", S), ev("chatMessageOutput", S));
  assert.equal(thread(S).stop_streak, 0);
  const asked: boolean[] = [];
  for (let round = 0; round < STOP_STREAK_LIMIT + 3; round++) {
    unread(S, `chatty-${round}`);
    const before = prompts.length;
    await hooks.event({ event: ev("sessionIdle", S) });
    const prompted = prompts.length > before;
    asked.push(prompted);
    if (prompted) {
      const out = ev("chatMessageOutput", S) as { parts: { text: string }[] };
      out.parts = [{ ...out.parts[1]!, text: prompts[prompts.length - 1]!.body.parts[0]!.text }];
      await hooks["chat.message"](ev("chatMessageInput", S), out as never);
    }
  }
  assert.deepEqual(asked.slice(0, STOP_STREAK_LIMIT + 1), [true, true, true, false], "three asks in a row, then the fourth idle is let through");
  for (const p of prompts) assert.ok(p.body.parts[0]!.text.startsWith(PREFIX), "every extra turn is asked for with an agentsocks line");
  assert.equal(thread(S).state, "idle");
  assert.doesNotMatch(JSON.stringify(prompts), /message chatty/);
});

test("two sessions that answer each other end up quiet: the exchange stops by itself once the hourly wake caps are used, and every turn it asked for was a content-free line", async () => {
  const { hooks, prompts } = await load();
  const A = "ses_ping00001";
  const B = "ses_pong00001";
  await hooks.event({ event: ev("sessionCreatedRoot", A) });
  await hooks.event({ event: ev("sessionCreatedRoot", B) });
  await until(() => sinkOf(broker, thread(A).remote ?? "")?.waiting, 8000);
  broker.store.db.prepare("UPDATE threads SET name = ? WHERE thread_id = ?").run("ping", `opencode_${A}`);
  broker.store.db.prepare("UPDATE threads SET name = ? WHERE thread_id = ?").run("pong", `opencode_${B}`);

  const now = Date.now();
  const ORDINARY_LEFT = 2;
  const EXEMPT_LEFT = 2;
  for (const id of [A, B]) {
    broker.store.updateThread(`opencode_${id}`, {
      wake_log: JSON.stringify(Array.from({ length: MAX_WAKES_PER_HOUR - ORDINARY_LEFT }, (_, i) => now - 60_000 - i * 1000)),
      exempt_wake_log: JSON.stringify(Array.from({ length: MAX_EXEMPT_WAKES_PER_HOUR - EXEMPT_LEFT }, (_, i) => now - 60_000 - i * 1000)),
    });
  }

  let sent = 0;
  const turn = async (session: string, other: string, text: string) => {
    const out = ev("chatMessageOutput", session) as { parts: { text: string }[] };
    out.parts = [{ ...out.parts[1]!, text }];
    await hooks["chat.message"](ev("chatMessageInput", session), out as never);
    broker.take(`opencode_${session}`);
    await broker.routeSend({ from: party(session), to: target(other), body: `turn ${++sent} from ${session}`, urgency: "normal" });
    await hooks.event({ event: ev("sessionIdle", session) });
    for (const id of [A, B]) await broker.wake(`opencode_${id}`);
  };

  let consumed = 0;
  let turns = 0;
  await turn(A, B, "start the exchange");
  const CAP = 80;
  while (turns < CAP) {
    try {
      await until(() => prompts.length > consumed, 1800);
    } catch {
      break;
    }
    const next = prompts[consumed++]!;
    const session = next.path.id;
    turns++;
    await turn(session, session === A ? B : A, next.body.parts[0]!.text);
  }

  const forA = prompts.filter((p) => p.path.id === A).length;
  const forB = prompts.filter((p) => p.path.id === B).length;
  assert.ok(turns < CAP, `the exchange ended by itself after ${turns} extra turns`);
  assert.ok(forA + forB >= 3, "the exchange did run for a while: the test is not vacuous");
  const perSessionBound = ORDINARY_LEFT + EXEMPT_LEFT + STOP_STREAK_LIMIT * (ORDINARY_LEFT + EXEMPT_LEFT + 1);
  assert.ok(forA <= perSessionBound && forB <= perSessionBound, `each session was asked for ${forA} and ${forB} extra turns, at most ${perSessionBound}`);
  assert.ok(audits("wake_skipped", "opencode_ses_p").length >= 1, "the cap was what stopped it, and the broker said so");
  for (const p of prompts) assert.ok(p.body.parts[0]!.text.startsWith(PREFIX));
  assert.doesNotMatch(JSON.stringify(prompts), /turn \d+ from/);
  await sleep(2500);
  assert.equal(prompts.length, consumed, "and once stopped it stays stopped");
});
