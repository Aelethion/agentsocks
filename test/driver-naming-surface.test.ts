import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import "./support.ts";
import { fakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { driver } from "../src/commands/driver.ts";
import { list } from "../src/commands/peers.ts";
import { formatVisible } from "../src/gateway/gtools.ts";
import { codexIdentity, listPeers } from "../src/peers.ts";
import { formatPeers } from "../src/tools/messaging.ts";

const broker = new Broker();
before(async () => {
  await broker.start();
});
after(async () => {
  await broker.stop();
});

const threadName = (id: string): string => broker.store.getThread(id)!.name;

async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    return { value: await fn(), out: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}

test("ending A does not rename B, and restarting A keeps its name", async () => {
  const A = "omp_w4by2a01";
  const B = "omp_w4by2b01";
  await broker.dispatch({ op: "register", threadId: A, cwd: "/work/w4bshared" });
  await broker.dispatch({ op: "register", threadId: B, cwd: "/work/w4bshared" });
  assert.equal(threadName(A), "omp-w4bshared");
  assert.equal(threadName(B), "omp-w4bshared-2");
  await broker.dispatch({ op: "hook", threadId: A, agent: "omp", event: "SessionEnd" });
  await broker.dispatch({ op: "hook", threadId: B, agent: "omp", event: "UserPromptSubmit", prompt: "keep going" });
  assert.equal(threadName(B), "omp-w4bshared-2", "B keeps -2 after A ends");
  await broker.dispatch({ op: "hook", threadId: A, agent: "omp", event: "SessionStart", cwd: "/work/w4bshared" });
  assert.equal(threadName(A), "omp-w4bshared", "a restarted session keeps its name, not omp-w4bshared-3");
});

test("a changed cwd re-derives the default name, a repeated cwd never renames", async () => {
  const C = "omp_w4by2c01";
  await broker.dispatch({ op: "register", threadId: C, cwd: "/work/w4balpha" });
  assert.equal(threadName(C), "omp-w4balpha");
  await broker.dispatch({ op: "hook", threadId: C, agent: "omp", event: "UserPromptSubmit", prompt: "hi" });
  assert.equal(threadName(C), "omp-w4balpha");
  await broker.dispatch({ op: "register", threadId: C, cwd: "/work/w4bbeta" });
  assert.equal(threadName(C), "omp-w4bbeta");
});

test("an OMP session name is a uniquified default, and a later SessionStart never overwrites an explicit set_name", async () => {
  const D = "omp_w4by11d01";
  const E = "omp_w4by11e01";
  await broker.dispatch({ op: "hook", threadId: D, agent: "omp", event: "SessionStart", cwd: "/work/w4bapi", name: "w4bmain" });
  await broker.dispatch({ op: "hook", threadId: E, agent: "omp", event: "SessionStart", cwd: "/work/w4bweb", name: "w4bmain" });
  assert.equal(threadName(D), "w4bmain");
  assert.equal(threadName(E), "w4bmain-2");
  assert.equal(broker.store.getThread(D)!.name_explicit, null, "a session name is a default, not explicit");
  await broker.dispatch({ op: "set_name", threadId: D, name: "w4bpilot" });
  await broker.dispatch({ op: "hook", threadId: D, agent: "omp", event: "SessionStart", cwd: "/work/w4bapi", name: "w4bmain" });
  assert.equal(threadName(D), "w4bpilot", "an explicit set_name survives a later SessionStart");
});

test("agentsocks list text shows the driver", async () => {
  const boss = "omp_w4by7boss01";
  const worker = "omp_w4by7work01";
  await broker.dispatch({ op: "register", threadId: boss, cwd: "/work/w4bboss" });
  await broker.dispatch({ op: "register", threadId: worker, cwd: "/work/w4bworker" });
  const bossRow = broker.store.getThread(boss)!;
  await broker.dispatch({ op: "set_driver", threadId: worker, addr: `uds:${broker.describe(bossRow).socketPath}`, name: bossRow.name });
  const { out } = await quiet(() => list([], "list"));
  assert.ok(out.includes(`driver ${bossRow.name}`), out);
});

test("the driver suffix shows only when the driver name is itself listed", async () => {
  const boss = "omp_w4by9boss01";
  const worker = "omp_w4by9work01";
  await broker.dispatch({ op: "register", threadId: boss, cwd: "/work/w4bb9" });
  await broker.dispatch({ op: "register", threadId: worker, cwd: "/work/w4bw9" });
  const bossRow = broker.store.getThread(boss)!;
  await broker.dispatch({ op: "set_driver", threadId: worker, addr: `uds:${broker.describe(bossRow).socketPath}`, name: bossRow.name });
  const all = await listPeers({});
  const me = await codexIdentity(worker);
  assert.ok(formatPeers(all, me, "codex").includes(`driver ${bossRow.name}`));
  assert.ok(formatVisible(all, "private").includes(`driver ${bossRow.name}`));
  const solo = all.filter((p) => p.session === worker);
  assert.ok(!formatPeers(solo, me, "codex").includes("driver "), "a driver outside the listed set stays hidden");
  assert.ok(!formatVisible(solo, "private").includes("driver "), "a driver outside the caller's view stays hidden");
});

test("the driver command sets and clears through the real broker path", async () => {
  const saved = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = "w4b-cli-worker-01";
  try {
    const boss = "w4b-cli-boss-01";
    await broker.dispatch({ op: "register", threadId: boss, cwd: "/work/w4bcli" });
    const bossName = threadName(boss);
    await quiet(() => driver([bossName], "driver"));
    assert.equal(broker.store.getThread("w4b-cli-worker-01")!.driver_name, bossName, "set stores the resolved driver");
    await quiet(() => driver(["none"], "driver"));
    assert.equal(broker.store.getThread("w4b-cli-worker-01")!.driver_addr, null, "clear actually clears");
    assert.equal(broker.store.getThread("w4b-cli-worker-01")!.driver_name, null);
  } finally {
    if (saved === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = saved;
  }
});

test("without a session identity the driver command refuses plainly and registers nothing", async () => {
  const saved = process.env.CODEX_THREAD_ID;
  delete process.env.CODEX_THREAD_ID;
  try {
    const before = broker.store.listThreads(true).length;
    await assert.rejects(quiet(() => driver(["somebody"], "driver")), /set_driver tool/);
    await assert.rejects(quiet(() => driver(["none"], "driver")), /set_driver tool/);
    assert.equal(broker.store.listThreads(true).length, before, "no phantom thread is registered");
  } finally {
    if (saved === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = saved;
  }
});

test("in a Claude shell the driver command refuses instead of registering a phantom thread", async () => {
  const saved = process.env.CODEX_THREAD_ID;
  delete process.env.CODEX_THREAD_ID;
  const session = await fakeClaude("w4bclaude", process.pid);
  try {
    const before = broker.store.listThreads(true).length;
    await assert.rejects(
      quiet(() => driver(["somebody"], "driver")),
      /Claude Code sessions are not broker sessions/,
    );
    assert.equal(broker.store.listThreads(true).length, before, "a Claude session id never becomes a thread");
  } finally {
    try {
      unlinkSync(join(process.env.AGENTSOCKS_CLAUDE_SESSIONS_DIR!, `${process.pid}.json`));
    } catch {}
    await closeServer(session.server);
    if (saved === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = saved;
  }
});

test("the real CLI refuses with no session and points at the tool", async () => {
  const exec = promisify(execFile);
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.CODEX_THREAD_ID;
  try {
    await exec(process.execPath, [cli, "driver", "somebody"], { env: env as NodeJS.ProcessEnv, timeout: 30_000 });
    assert.fail("the CLI should refuse without a session identity");
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    assert.notEqual(x.code, 0);
    assert.match(`${x.stdout ?? ""}\n${x.stderr ?? ""}`, /set_driver tool/);
  }
});

test("a hidden subagent's name stays out of the visible taken set", async () => {
  const hidden = "omp_w4by14h01";
  const visible = "omp_w4by14v01";
  await broker.dispatch({ op: "register", threadId: hidden, cwd: "/work/w4bhidden" });
  broker.store.updateThread(hidden, { subagent: 1 });
  await broker.dispatch({ op: "register", threadId: visible, cwd: "/work/w4bhidden" });
  assert.equal(threadName(visible), "omp-w4bhidden", "the subagent name does not force a -2 suffix");
});

test("two live sessions off one folder pin the exact -2 suffix", async () => {
  const first = "opencode_w4by14a01";
  const second = "opencode_w4by14b01";
  await broker.dispatch({ op: "register", threadId: first, agent: "opencode", cwd: "/work/w4bapix" });
  await broker.dispatch({ op: "register", threadId: second, agent: "opencode", cwd: "/work/w4bapix" });
  assert.equal(threadName(first), "opencode-w4bapix");
  assert.equal(threadName(second), "opencode-w4bapix-2");
});

test("describe shows the driver's current name after it renames", async () => {
  const boss = "omp_w4by10boss1";
  const worker = "omp_w4by10work1";
  await broker.dispatch({ op: "register", threadId: boss, cwd: "/work/w4bb10" });
  await broker.dispatch({ op: "register", threadId: worker, cwd: "/work/w4bw10" });
  const bossRow = broker.store.getThread(boss)!;
  await broker.dispatch({ op: "set_driver", threadId: worker, addr: `uds:${broker.describe(bossRow).socketPath}`, name: bossRow.name });
  assert.equal(broker.describe(broker.store.getThread(worker)!).driver, bossRow.name);
  await broker.dispatch({ op: "set_name", threadId: boss, name: "renamed-boss" });
  assert.equal(broker.describe(broker.store.getThread(worker)!).driver, "renamed-boss", "headings follow the live name, not the snapshot");
});
