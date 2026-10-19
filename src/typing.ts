import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface TtyActivity {
  pid: number;
  tty: string;
  inputAgeMs: number;
}

export type GuardVerdict = "deliver" | "hold";

// a pty's atime only moves in steps of about 8 s, so a 30 s window can really mean 22 s and a 10 s gap 2 s
export const TYPING_WINDOW_MS = 38_000;
export const HOLD_LIMIT_MS = 10 * 60_000;
export const QUIET_GAP_MS = 18_000;

const NOT_A_TUI = new Set(["app-server", "exec", "queue", "mcp"]);
const PTS = /^\/dev\/pts\/\d+$/;

function atimeMs(path: string): number | undefined {
  try {
    return statSync(path).atimeMs;
  } catch {
    return undefined;
  }
}

// tests and sandboxes point this at a fake tree so the real process table is never read
function procRootDir(): string {
  return process.env.AGENTSOCKS_PROC_ROOT || "/proc";
}

// only Linux exposes a pty's input time as an access time; elsewhere nothing is scanned, so a wake is never held for typing
export function scanCodexTtys(
  now: number = Date.now(),
  procRoot: string = procRootDir(),
  statAtime: (path: string) => number | undefined = atimeMs,
  platform: NodeJS.Platform = process.platform,
): TtyActivity[] {
  if (platform !== "linux") return [];
  let pids: string[];
  try {
    pids = readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const found: TtyActivity[] = [];
  for (const name of pids) {
    try {
      const args = readFileSync(join(procRoot, name, "cmdline"), "utf8").split("\0");
      if (basename(args[0] ?? "") !== "codex" || args.slice(1).some((a) => NOT_A_TUI.has(a))) continue;
      const tty = readlinkSync(join(procRoot, name, "fd", "0"));
      if (!PTS.test(tty)) continue;
      const atime = statAtime(tty);
      if (atime === undefined) continue;
      found.push({ pid: Number(name), tty, inputAgeMs: Math.max(0, now - atime) });
    } catch {}
  }
  return found;
}

export function typingGuard(ttys: TtyActivity[], heldSinceMs: number | null, now: number): GuardVerdict {
  if (ttys.length === 0) return "deliver";
  const heldTooLong = heldSinceMs !== null && now - heldSinceMs >= HOLD_LIMIT_MS;
  if (heldTooLong) return ttys.every((t) => t.inputAgeMs >= QUIET_GAP_MS) ? "deliver" : "hold";
  return ttys.some((t) => t.inputAgeMs < TYPING_WINDOW_MS) ? "hold" : "deliver";
}
