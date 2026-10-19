import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface ProcSource {
  read(path: string): string | undefined;
  ps(args: string[]): string | undefined;
}

export const systemProc: ProcSource = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  ps(args) {
    try {
      return execFileSync("ps", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return undefined;
    }
  },
};

export const hasProcfs = (platform: NodeJS.Platform): boolean => platform === "linux" || platform === "android";

const statFields = (stat: string): string[] => stat.slice(stat.lastIndexOf(")") + 2).split(" ");

function parseStatParent(stat: string): number | undefined {
  const ppid = Number(statFields(stat)[1]);
  return Number.isInteger(ppid) ? ppid : undefined;
}

function parsePsParent(out: string | undefined): number | undefined {
  const text = out?.trim();
  if (!text) return undefined;
  const ppid = Number(text);
  return Number.isInteger(ppid) ? ppid : undefined;
}

export function parentPid(pid: number, platform: NodeJS.Platform = process.platform, src: ProcSource = systemProc): number | undefined {
  if (hasProcfs(platform)) {
    const stat = src.read(`/proc/${pid}/stat`);
    const fromProc = stat === undefined ? undefined : parseStatParent(stat);
    if (fromProc !== undefined) return fromProc;
  }
  return parsePsParent(src.ps(["-o", "ppid=", "-p", String(pid)]));
}

export function processStart(pid: number, platform: NodeJS.Platform = process.platform, src: ProcSource = systemProc): string | undefined {
  if (!hasProcfs(platform)) return undefined;
  const stat = src.read(`/proc/${pid}/stat`);
  return stat === undefined ? undefined : statFields(stat)[19] || undefined;
}

// ps joins the arguments with spaces, so a path containing a space comes back split; callers match whole words, which survives that
export function processArgs(pid: number, platform: NodeJS.Platform = process.platform, src: ProcSource = systemProc): string[] | undefined {
  if (hasProcfs(platform)) {
    const raw = src.read(`/proc/${pid}/cmdline`);
    if (raw !== undefined) return raw.split("\0");
  }
  const line = src.ps(["-ww", "-o", "args=", "-p", String(pid)])?.trim();
  return line ? line.split(/\s+/) : undefined;
}

export function validKillTarget(pid: unknown): pid is number {
  return Number.isSafeInteger(pid) && (pid as number) > 1 && pid !== process.pid && pid !== process.ppid;
}

export function buildHash(dir: string): string | undefined {
  const names: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const at = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(at);
      else if (entry.isFile()) names.push(at);
    }
  };
  try {
    walk("");
  } catch {
    return undefined;
  }
  if (names.length === 0) return undefined;
  const hash = createHash("sha256");
  try {
    for (const name of names.sort()) hash.update(name).update("\0").update(readFileSync(join(dir, name))).update("\0");
  } catch {
    return undefined;
  }
  return hash.digest("hex");
}
