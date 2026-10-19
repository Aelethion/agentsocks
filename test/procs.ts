import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface TestDaemon {
  pid: number;
  runtimeDir?: string;
  args: string;
}

const isDaemonLine = (args: string): boolean => /[/]cli\.(ts|js) daemon( |$)/.test(args);

export function testDaemons(): TestDaemon[] {
  let out = "";
  try {
    out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8", timeout: 10_000 });
  } catch {
    return [];
  }
  const found: TestDaemon[] = [];
  for (const line of out.split("\n")) {
    const m = /^(\d+)\s+\d+\s+(.*)$/.exec(line.trim());
    if (!m || !isDaemonLine(m[2]!)) continue;
    const pid = Number(m[1]);
    let runtimeDir: string | undefined;
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      runtimeDir = env.find((e) => e.startsWith("AGENTSOCKS_RUNTIME_DIR="))?.slice("AGENTSOCKS_RUNTIME_DIR=".length) || undefined;
    } catch {}
    found.push({ pid, runtimeDir, args: m[2]! });
  }
  return found;
}

const procState = (pid: number): string | undefined => {
  try {
    const after = readFileSync(`/proc/${pid}/stat`, "utf8").split(")");
    const state = after[after.length - 1]!.trim().split(/\s+/)[0];
    return state || undefined;
  } catch {
    try {
      return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()[0];
    } catch {
      return undefined;
    }
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = procState(pid);
  return state === undefined || state !== "Z";
};

const waitExit = (pid: number, ms: number): boolean => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return !alive(pid);
};

import { validKillTarget } from "../src/procinfo.ts";
export { validKillTarget };

export function reapDaemon(pid: number, opts: { group?: boolean; timeoutMs?: number } = {}): boolean {
  if (!validKillTarget(pid)) throw new Error(`refusing to kill pid ${String(pid)}`);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  if (!alive(pid)) return true;
  if (opts.group === true) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  if (waitExit(pid, timeoutMs)) return true;
  if (opts.group === true) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  return waitExit(pid, 5000);
}

export function reapPidFile(runtimeDir: string, timeoutMs = 10_000): boolean {
  if (typeof runtimeDir !== "string" || runtimeDir === "") throw new Error(`refusing to reap with runtime dir ${JSON.stringify(runtimeDir)}`);
  let reaped = false;
  let text: string | undefined;
  try {
    text = readFileSync(join(runtimeDir, "broker.lock", "pid"), "utf8").trim();
  } catch {}
  if (text !== undefined) {
    if (!/^\d+$/.test(text)) throw new Error(`refusing to kill pid text ${JSON.stringify(text)} from ${runtimeDir}/broker.lock/pid`);
    const pid = Number(text);
    if (!validKillTarget(pid)) throw new Error(`refusing to kill pid ${String(pid)} from ${runtimeDir}/broker.lock/pid`);
    reaped = reapDaemon(pid, { timeoutMs });
  }
  for (const stray of testDaemons()) if (stray.runtimeDir === runtimeDir && validKillTarget(stray.pid)) reapDaemon(stray.pid, { timeoutMs });
  return reaped;
}

function underOwnRoot(env: string[], root: string): boolean {
  return env.some((e) => {
    if (!(e.startsWith("AGENTSOCKS_RUNTIME_DIR=") || e.startsWith("AGENTSOCKS_STATE_DIR=") || e.startsWith("HOME=") || e.startsWith("TMPDIR="))) return false;
    const value = e.slice(e.indexOf("=") + 1);
    return value === root || value.startsWith(`${root}/`);
  });
}

export function ownRunPids(match: (args: string) => boolean): number[] {
  const root = process.env.TMPDIR;
  if (root === undefined) return [];
  let out = "";
  try {
    out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 10_000 });
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const line of out.split("\n")) {
    const m = /^(\d+)\s+(.*)$/.exec(line.trim());
    if (!m || !match(m[2]!)) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (underOwnRoot(env, root)) found.push(pid);
    } catch {}
  }
  return found;
}

export function ownRunWithEnviron(text: string): number[] {
  const root = process.env.TMPDIR;
  if (root === undefined) return [];
  let pids: string[];
  try {
    pids = execFileSync("ps", ["-eo", "pid="], { encoding: "utf8", timeout: 10_000 }).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const raw of pids) {
    const pid = Number(raw);
    if (!pid || pid === process.pid) continue;
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (env.some((e) => e.includes(text)) && underOwnRoot(env, root)) found.push(pid);
    } catch {}
  }
  return found;
}
