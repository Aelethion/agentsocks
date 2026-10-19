#!/usr/bin/env node
// Single-owner test runner: the one process that creates the run root is
// the only one that ever deletes it. Usage: node scripts/test.mjs [globs...].
import { spawn } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { parseEnvironRoots } from "./parse-environ.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join("/tmp", "asr-"));
console.log(`run root: ${root}`);

const globs = process.argv.slice(2);
const files = globs.length > 0 ? globs : ["test/**/*.test.ts"];
const child = spawn(
  process.execPath,
  ["--import", "./test/setup.ts", "--test", "--test-concurrency=1", ...(process.platform === "linux" ? [] : ["--test-force-exit"]), ...files],
  { cwd: repo, env: { ...process.env, TMPDIR: root }, stdio: "inherit", detached: true },
);

const signalForwards = [];
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const forward = () => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };
  process.on(sig, forward);
  signalForwards.push([sig, forward]);
}

child.on("error", (err) => {
  console.error(`suite child failed to start: ${String(err)}`);
  process.exit(1);
});

const childCode = await new Promise((done) => {
  child.on("exit", (code, signal) => done(signal === null ? code ?? 1 : 1));
});
for (const [sig, forward] of signalForwards) process.removeListener(sig, forward);

const underRoot = (dir) => {
  const abs = resolve(dir);
  return abs === root || abs.startsWith(root + sep);
};

const validTarget = (pid) =>
  Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readEnviron = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  } catch {
    return undefined;
  }
};

const scanLeftovers = () => {
  const found = [];
  if (process.platform === "linux" || process.platform === "android") {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (!validTarget(pid)) continue;
      const env = readEnviron(pid);
      if (env === undefined) continue;
      const { runtime, tmp, testFile } = parseEnvironRoots(env);
      const dir = (runtime !== undefined && underRoot(runtime)) ? runtime
        : (tmp !== undefined && underRoot(tmp)) ? tmp : undefined;
      if (dir === undefined) continue;
      let cmd = "";
      try {
        cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      } catch {}
      found.push({ pid, dir, cmd, testFile: testFile ?? "(unknown file)" });
    }
  } else {
    console.log("leftover scan skipped: no /proc on this platform; the suite must leave nothing");
  }
  return found;
};

let leftovers = scanLeftovers();
let leaked = false;
for (const { pid, dir, cmd, testFile } of leftovers) {
  const sub = dir === root ? "." : dir.slice(root.length + 1).split(sep)[0];
  console.log(`leftover: pid ${pid} runtime ${dir} file-subdir ${sub} cmd ${cmd} test-file ${testFile}`);
  leaked = true;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}
const end = Date.now() + 5000;
for (;;) {
  const pending = leftovers.filter(({ pid }) => alive(pid));
  if (pending.length === 0 || Date.now() > end) {
    for (const { pid } of pending) {
      const env = readEnviron(pid);
      if (env === undefined) continue;
      const { runtime, tmp, testFile } = parseEnvironRoots(env);
      const dir = (runtime !== undefined && underRoot(runtime)) ? runtime
        : (tmp !== undefined && underRoot(tmp)) ? tmp : undefined;
      if (dir === undefined) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
leftovers = scanLeftovers().filter(({ pid }) => alive(pid));
for (const { pid, dir, cmd, testFile } of leftovers) {
  const sub = dir === root ? "." : dir.slice(root.length + 1).split(sep)[0];
  console.log(`leftover child: pid ${pid} runtime ${dir} file-subdir ${sub} cmd ${cmd} test-file ${testFile}`);
  leaked = true;
}

let proven = resolve(root).startsWith("/tmp" + sep);
try {
  proven = proven && !lstatSync(root).isSymbolicLink();
} catch {
  proven = false;
}
if (!proven) {
  console.error(`refusing to remove unproven run root ${root}`);
  process.exit(1);
}
try {
  rmSync(root, { recursive: true, force: true });
} catch (err) {
  console.error(`run root removal failed for ${root}: ${String(err)}`);
  process.exit(1);
}

if (leaked) {
  console.error("leaks found: failing the run by name (see leftover lines above)");
  process.exit(1);
}
process.exit(childCode);
