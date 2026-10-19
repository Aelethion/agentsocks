import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./support.ts";
import { reapDaemon } from "./procs.ts";
import { tempDir } from "./tmp.ts";

const tracked: number[] = [];

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

after(() => {
  for (const pid of tracked) {
    try {
      reapDaemon(pid, { group: true });
    } catch {}
  }
});

async function startGroupDaemon(): Promise<{ daemon: number; grandchild: number }> {
  const sub = tempDir("w2d-h4-cli-");
  const cli = join(sub, "cli.ts");
  writeFileSync(
    cli,
    `const { spawn } = require("node:child_process");\nconst g = spawn("sleep", ["600"], { stdio: "ignore" });\nconsole.log("grandchild " + g.pid);\nsetInterval(() => {}, 1000);\n`,
  );
  const runtime = join(tempDir("w2d-h4-"), "run");
  mkdirSync(runtime, { recursive: true });
  const child = spawn(process.execPath, [cli, "daemon"], {
    env: { ...process.env, AGENTSOCKS_RUNTIME_DIR: runtime },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.unref();
  let grandchild = 0;
  child.stdout!.on("data", (d) => {
    for (const line of String(d).split("\n")) {
      const m = /grandchild (\d+)/.exec(line);
      if (m) grandchild = Number(m[1]);
    }
  });
  const end = Date.now() + 10_000;
  for (;;) {
    if (child.pid !== undefined && grandchild) {
      tracked.push(child.pid, grandchild);
      return { daemon: child.pid, grandchild };
    }
    if (Date.now() > end) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      throw new Error("group daemon never appeared");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("group kill reaps the daemon's grandchild", async () => {
  const { daemon, grandchild } = await startGroupDaemon();
  assert.ok(reapDaemon(daemon, { group: true }));
  await gone(daemon, "the daemon is gone");
  await gone(grandchild, "the grandchild in its group is gone");
});

test("pid-only kill leaves the grandchild, proving group kill does the work", async () => {
  const { daemon, grandchild } = await startGroupDaemon();
  const origKill = process.kill;
  try {
    process.kill = ((pid: number, sig?: number | string) => (pid < 0 ? undefined : origKill(pid, sig as never))) as typeof process.kill;
    assert.ok(reapDaemon(daemon));
    await gone(daemon, "the daemon is gone");
    let alive = true;
    try {
      process.kill(grandchild, 0);
    } catch {
      alive = false;
    }
    assert.ok(alive, "without process.kill(-pid, ...) the grandchild survives");
  } finally {
    process.kill = origKill;
  }
  try {
    process.kill(-daemon, "SIGKILL");
  } catch {}
  await gone(grandchild, "group kill reaches the reparented grandchild");
  await gone(daemon, "the daemon is gone");
});
