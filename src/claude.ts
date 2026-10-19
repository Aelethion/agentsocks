import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { basename, join } from "node:path";
import { ENTRYPOINT } from "./claudelist.ts";
import { claudeSessionsDir } from "./paths.ts";
import { parentPid, processArgs, processStart, systemProc, type ProcSource } from "./procinfo.ts";

export interface ClaudeSession {
  pid: number;
  sessionId?: string;
  name: string;
  cwd?: string;
  socketPath: string;
  kind?: string;
  entrypoint?: string;
  status?: string;
  waitingFor?: string;
  updatedAt?: number;
  procStart?: string;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isSocket(path: string): boolean {
  try {
    return lstatSync(path).isSocket();
  } catch {
    return false;
  }
}

function readRecord(dir: string, file: string, needSocket = true): ClaudeSession | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
  } catch {
    return undefined;
  }
  const pid = Number(raw.pid ?? file.replace(/\.json$/, ""));
  const socketPath = typeof raw.messagingSocketPath === "string" ? raw.messagingSocketPath : undefined;
  if (!Number.isInteger(pid) || (!socketPath && needSocket)) return undefined;
  const cwd = typeof raw.cwd === "string" ? raw.cwd : undefined;
  const given = typeof raw.name === "string" && raw.name ? raw.name : "";
  const folder = cwd ? basename(cwd).normalize("NFKC").replace(/\(\s*(remote|phone|api|guest)\s*\)/gi, " ").replace(/@/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) : "";
  const usable = given.normalize("NFKC").replace(/\s+/g, " ").trim();
  const name = given && !/\(\s*(remote|phone|api|guest)\s*\)/i.test(usable.toLowerCase()) && !usable.includes("@") ? given : `claude-${folder || pid}`;
  return {
    pid,
    socketPath: socketPath ?? "",
    name,
    ...(typeof raw.sessionId === "string" && SESSION_ID.test(raw.sessionId) && { sessionId: raw.sessionId }),
    ...(cwd && { cwd }),
    ...(typeof raw.kind === "string" && { kind: raw.kind }),
    ...(typeof raw.entrypoint === "string" && { entrypoint: raw.entrypoint }),
    ...(typeof raw.status === "string" && { status: raw.status }),
    ...(typeof raw.waitingFor === "string" && { waitingFor: raw.waitingFor }),
    ...(typeof raw.updatedAt === "number" && { updatedAt: raw.updatedAt }),
    ...(typeof raw.procStart === "string" && { procStart: raw.procStart }),
    ...(raw.spare === true && { kind: "spare" }),
  };
}

const comparesStart = (platform: NodeJS.Platform): boolean => platform === "linux";

function startMatches(record: ClaudeSession, platform: NodeJS.Platform, src: ProcSource): boolean {
  return record.procStart === undefined || !comparesStart(platform) || processStart(record.pid, platform, src) === record.procStart;
}

export function listClaudeSessions(platform: NodeJS.Platform = process.platform, src: ProcSource = systemProc): ClaudeSession[] {
  const dir = claudeSessionsDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  return files
    .map((f) => readRecord(dir, f))
    .filter((s): s is ClaudeSession => !!s && s.kind !== "spare" && s.kind !== "daemon" && s.entrypoint !== ENTRYPOINT && pidAlive(s.pid) && isSocket(s.socketPath) && startMatches(s, platform, src));
}

export function namesClaude(args: string[] | undefined): boolean {
  const given = args?.filter((arg) => arg !== "") ?? [];
  const retitled = given.length === 1 && given[0]!.startsWith("claude ");
  return retitled || given.some((arg) => basename(arg) === "claude" || basename(arg) === "claude.exe" || arg.includes("/claude-code/") || arg.includes("/claude/versions/"));
}

export type Proof = "identity" | "framing";

function provesProcess(record: ClaudeSession, pid: number, platform: NodeJS.Platform, src: ProcSource, proof: Proof): boolean {
  if (record.pid !== pid || (proof === "identity" && !isSocket(record.socketPath))) return false;
  if (!startMatches(record, platform, src)) return false;
  return pid !== 1 || namesClaude(processArgs(pid, platform, src));
}

// "framing" asks only whether an agent may be reading, so a record whose socket is missing still counts: the cost of being wrong is a frame around text a person reads
export function findOwnClaudeSession(
  startPid = process.pid,
  parent: (pid: number) => number | undefined = parentPid,
  platform: NodeJS.Platform = process.platform,
  src: ProcSource = systemProc,
  proof: Proof = "identity",
): ClaudeSession | undefined {
  const dir = claudeSessionsDir();
  let pid: number | undefined = startPid;
  for (let depth = 0; pid !== undefined && pid >= 1 && depth < 24; depth++) {
    const record = readRecord(dir, `${pid}.json`, proof === "identity");
    if (record && provesProcess(record, pid, platform, src, proof)) return record;
    pid = parent(pid);
  }
  return undefined;
}

export function runsUnderClaude(startPid = process.pid, parent: (pid: number) => number | undefined = parentPid, platform: NodeJS.Platform = process.platform, src: ProcSource = systemProc): boolean {
  return findOwnClaudeSession(startPid, parent, platform, src, "framing") !== undefined;
}
