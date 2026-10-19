import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPlugin, type Deps, type Hooks, type PluginInput } from "../src/agents/opencode/runtime.ts";

const PREFIX = "📨 agentsocks:";
const hex = { toString: () => "ab".repeat(12) };

interface Spawned {
  args: string[];
  stdin: string;
  killed: boolean;
  env: Record<string, string | undefined>;
  release?: (stdout: string) => void;
}

function harness(reply: (spawned: Spawned) => { stdout: string; code: number } | "hold" | undefined) {
  const spawned: Spawned[] = [];
  const prompts: { path: { id: string }; body: { parts: { text: string }[] } }[] = [];
  const spawn = ((_node: string, argv: string[], options: { env: Record<string, string | undefined> }) => {
    const record: Spawned = { args: argv.slice(1), stdin: "", killed: false, env: options.env };
    spawned.push(record);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    child.stdout = stdout;
    child.stdin = Object.assign(new EventEmitter(), {
      end: (input: string) => {
        record.stdin = input;
        setImmediate(() => {
          const out = reply(record);
          if (out === "hold") {
            record.release = (text) => {
              stdout.emit("data", text);
              child.emit("close", 0);
            };
            return;
          }
          if (out?.stdout) stdout.emit("data", out.stdout);
          if (!record.killed) child.emit("close", out?.code ?? 1);
        });
      },
    });
    child.kill = () => {
      record.killed = true;
      setImmediate(() => child.emit("close", null));
      return true;
    };
    return child;
  }) as unknown as Deps["spawn"];
  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, directory: "/work/api" } }),
      promptAsync: async (options: (typeof prompts)[number]) => {
        prompts.push(options);
        return undefined;
      },
    },
  };
  const deps: Deps = { spawn, randomBytes: () => hex, tool: (definition) => definition, node: "/node", cli: "/cli", tools: [] };
  const input: PluginInput = { client: client as never, directory: "/work/api" };
  const wakePolls = () => spawned.filter((s) => s.args[2] === "wake").length;
  return { spawned, prompts, deps, input, wakePolls };
}

const created = (id: string) => ({ type: "session.created", properties: { info: { id, directory: "/work/api" } } });
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};
const live: Hooks[] = [];

afterEach(async () => {
  mock.timers.reset();
  for (const hooks of live.splice(0)) await hooks.dispose();
});

test("the wake poll is restarted when it returns, waits 2 s then doubling up to a minute when the broker does not answer, and stops for good on dispose", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let answering = false;
  const h = harness((s) => (s.args[2] === "wake" && answering ? { stdout: '{"wakes":[]}', code: 0 } : undefined));
  const hooks = await createPlugin(h.deps, h.input);
  live.push(hooks);
  await hooks.event({ event: created("ses_loop00001") } as never);
  await flush();
  assert.equal(h.wakePolls(), 1);

  const expectedWaits = [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000];
  let polls = 1;
  for (const wait of expectedWaits) {
    mock.timers.tick(wait - 1);
    await flush();
    assert.equal(h.wakePolls(), polls, `still waiting ${wait} ms after the failure`);
    mock.timers.tick(1);
    await flush();
    polls++;
    assert.equal(h.wakePolls(), polls, `polled again after ${wait} ms`);
  }

  answering = true;
  mock.timers.tick(60_000);
  await flush();
  polls++;
  assert.equal(h.wakePolls(), polls);
  mock.timers.tick(999);
  await flush();
  assert.equal(h.wakePolls(), polls, "an answer that came back at once is not asked for again at once");
  mock.timers.tick(1);
  await flush();
  assert.equal(h.wakePolls(), polls + 1, "and a quiet poll is followed by the next one");

  await hooks.dispose();
  const after = h.wakePolls();
  mock.timers.tick(10 * 60_000);
  await flush();
  assert.equal(h.wakePolls(), after, "nothing polls after dispose");
});

test("a poll that brings a wake prompts the session and starts the next poll without waiting", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let wakes = 1;
  const h = harness((s) => {
    if (s.args[2] !== "wake") return undefined;
    if (wakes-- > 0) return { stdout: JSON.stringify({ wakes: [{ session: "ses_loop00002", line: `${PREFIX} new message from a Claude Code session. Read it with agentsocks_read_inbox.` }] }), code: 0 };
    return { stdout: '{"wakes":[]}', code: 0 };
  });
  const hooks = await createPlugin(h.deps, h.input);
  live.push(hooks);
  await hooks.event({ event: created("ses_loop00002") } as never);
  await flush();
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0]!.path.id, "ses_loop00002");
  assert.equal(h.wakePolls(), 2, "the second poll started straight after the first brought a wake");
});

test("the poll asks the broker for no more than its own sink and a bounded time, and tells it nothing else", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(() => undefined);
  const hooks = await createPlugin(h.deps, h.input);
  live.push(hooks);
  await hooks.event({ event: created("ses_loop00003") } as never);
  await flush();
  const poll = h.spawned.find((s) => s.args[2] === "wake")!;
  assert.deepEqual(JSON.parse(poll.stdin), { sink: "ab".repeat(12), timeoutMs: 25_000 });
  assert.deepEqual(poll.args.slice(0, 3), ["hook", "opencode", "wake"]);
  const start = h.spawned.find((s) => s.args[2] === "SessionStart")!;
  assert.deepEqual(JSON.parse(start.stdin), { session: "ses_loop00003", remote: "ab".repeat(12), cwd: "/work/api" });
});

test("a handler that is given something it cannot make sense of resolves instead of raising an error into OpenCode", async () => {
  const h = harness(() => undefined);
  const hooks = await createPlugin(h.deps, h.input);
  live.push(hooks);
  await hooks.event({ event: null } as never);
  await hooks.event({} as never);
  await hooks["chat.message"]({} as never, {} as never);
  await hooks["chat.message"]({ sessionID: "ses_odd0000001" }, { parts: null } as never);
  await hooks["tool.execute.after"]({} as never, {} as never);
  await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_odd0000001" }, null as never);
});

test("the commands the plugin starts get the variables agentsocks needs and not the provider keys or the server password OpenCode runs with", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { ANTHROPIC_API_KEY: "key-one", OPENAI_API_KEY: "key-two", OPENCODE_SERVER_PASSWORD: "pw", AGENTSOCKS_STATE_DIR: "/state", XDG_RUNTIME_DIR: "/run/user/1", LC_ALL: "C" });
  try {
    const h = harness(() => undefined);
    const hooks = await createPlugin(h.deps, h.input);
    live.push(hooks);
    await hooks.event({ event: created("ses_env000001") } as never);
    await flush();
    assert.ok(h.spawned.length >= 2);
    for (const s of h.spawned) {
      assert.equal(s.env.AGENTSOCKS_STATE_DIR, "/state");
      assert.equal(s.env.XDG_RUNTIME_DIR, "/run/user/1");
      assert.equal(s.env.LC_ALL, "C");
      assert.equal(s.env.HOME, saved.HOME);
      for (const secret of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCODE_SERVER_PASSWORD"]) assert.equal(s.env[secret], undefined, secret);
    }
  } finally {
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCODE_SERVER_PASSWORD", "AGENTSOCKS_STATE_DIR", "XDG_RUNTIME_DIR", "LC_ALL"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("a session the plugin believes is busy is not woken, unless nothing has happened in it for as long as the broker waits before it stops trusting a busy state", async () => {
  mock.timers.enable({ apis: ["Date"] });
  const h = harness((s) => (s.args[2] === "wake" ? "hold" : undefined));
  const hooks = await createPlugin(h.deps, h.input);
  live.push(hooks);
  const line = `${PREFIX} new message from a Claude Code session. Read it with agentsocks_read_inbox.`;
  const deliver = async () => {
    const poll = h.spawned.filter((s) => s.args[2] === "wake" && s.release).at(-1)!;
    poll.release!(JSON.stringify({ wakes: [{ session: "ses_stale0001", line }] }));
    await flush();
  };
  await hooks.event({ event: created("ses_stale0001") } as never);
  await flush();
  await hooks["chat.message"]({ sessionID: "ses_stale0001" }, { parts: [{ type: "text", text: "work" }] } as never);
  mock.timers.tick(14 * 60_000);
  await deliver();
  assert.equal(h.prompts.length, 0, "busy 14 minutes ago: dropped");
  mock.timers.tick(2 * 60_000);
  await deliver();
  assert.equal(h.prompts.length, 1, "nothing for 16 minutes: the busy state is not trusted, so it is woken");
  await deliver();
  assert.equal(h.prompts.length, 1, "and having prompted it, it is busy again");
});
