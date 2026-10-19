import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./support.ts";
import { reapDaemon, reapPidFile, testDaemons, validKillTarget } from "./procs.ts";
import { tempDir } from "./tmp.ts";

const children: ChildProcess[] = [];

after(() => {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {}
  }
});

// A stub with a daemon's argv shape and environment, without a broker's slow
// boot: boots instantly, so the test pins the reaper rather than the machine.
async function gone(pid: number, why: string): Promise<void> {
  const end = Date.now() + 10_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > end) throw new Error(`process ${pid} still alive: ${why}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function startStub(root: string): Promise<number> {
  const dir = tempDir("procs-stub-");
  const cli = join(dir, "cli.ts");
  writeFileSync(cli, "setInterval(() => {}, 1000);\n");
  const runtime = join(root, "run");
  mkdirSync(runtime, { recursive: true });
  const child = spawn(process.execPath, [cli, "daemon"], {
    env: { ...process.env, AGENTSOCKS_RUNTIME_DIR: runtime },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  children.push(child);
  const end = Date.now() + 10_000;
  for (;;) {
    if (child.pid !== undefined) return child.pid;
    if (Date.now() > end) throw new Error("stub daemon never appeared");
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("testDaemons sees a daemon by argv and resolves its runtime dir", { skip: process.platform !== "linux" && "reads /proc/<pid>/environ" }, async () => {
  const root = tempDir("agentsocks-procs-see-");
  const runtime = join(root, "run");
  mkdirSync(runtime, { recursive: true });
  const before = new Set(testDaemons().map((d) => d.pid));
  await startStub(root);
  const seen = testDaemons().find((d) => d.runtimeDir === runtime && !before.has(d.pid));
  assert.ok(seen, "the fresh stub is listed with its runtime dir");
});

test("reapDaemon stops its own detached group", async () => {
  const root = tempDir("procs-reap-");
  const pid = await startStub(root);
  assert.equal(reapDaemon(pid, { group: true }), true);
  await gone(pid, "the daemon is gone");
});

test("reapDaemon refuses what it must never signal", () => {
  for (const bad of [-1, 0, 1, NaN, 1.5, process.pid, process.ppid]) {
    assert.equal(validKillTarget(bad), false, `pid ${String(bad)} is refused`);
    assert.throws(() => reapDaemon(bad as number), /refusing to kill/);
  }
  assert.equal(validKillTarget(process.pid + 1000000), true, "an unrelated pid passes validation");
});

test("reapPidFile follows the pid file", async () => {
  const root = tempDir("agentsocks-procs-pid-");
  const runtime = join(root, "run");
  mkdirSync(join(runtime, "broker.lock"), { recursive: true });
  const pid = await startStub(root);
  writeFileSync(join(runtime, "broker.lock", "pid"), String(pid));
  assert.equal(reapPidFile(runtime), true);
  await gone(pid, "the pid-file daemon is gone");
});

test("reapPidFile refuses a hostile pid file", async () => {
  const root = tempDir("procs-hostile-");
  const runtime = join(root, "run");
  mkdirSync(join(runtime, "broker.lock"), { recursive: true });
  writeFileSync(join(runtime, "broker.lock", "pid"), "-1\n");
  assert.throws(() => reapPidFile(runtime), /refusing to kill/);
});

test("reapPidFile refuses an empty runtime dir instead of matching every daemon whose runtime dir is unknown", () => {
  assert.throws(() => reapPidFile(""), /refusing to reap/);
});

test("reapPidFile reaps a daemon of its runtime dir that never wrote a pid file", { skip: process.platform !== "linux" && "finds the daemon through /proc/<pid>/environ" }, async () => {
  const root = tempDir("procs-nopid-");
  const pid = await startStub(root);
  assert.equal(reapPidFile(join(root, "run")), false, "there was no pid file to reap by");
  await gone(pid, "the daemon without a pid file is reaped as a stray");
});
