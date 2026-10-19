import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import type { InboxAgentId, InstallContext } from "./types.ts";

export const HOOK_MARKER = "AGENTSOCKS_HOOK=1 ";

export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function markedCommand(ctx: InstallContext, agent: InboxAgentId, ...rest: string[]): string {
  return HOOK_MARKER + ctx.command("hook", agent, ...rest).map(shellQuote).join(" ");
}

export const isOurCommand = (command: unknown): boolean => typeof command === "string" && command.startsWith(HOOK_MARKER);

export function onPath(name: string, pathVar: string | undefined = process.env.PATH): boolean {
  for (const dir of (pathVar ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      const file = join(dir, name);
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

export interface JsonFile {
  path: string;
  existed: boolean;
  doc: Record<string, unknown>;
}

export function readJsonObject(path: string): JsonFile {
  if (!existsSync(path)) return { path, existed: false, doc: {} };
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return { path, existed: true, doc: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message}); left untouched`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} does not hold a JSON object; left untouched`);
  return { path, existed: true, doc: parsed as Record<string, unknown> };
}

export function linkTarget(path: string): string {
  let current = path;
  for (let hops = 0; hops < 16; hops++) {
    let st;
    try {
      st = lstatSync(current);
    } catch {
      return current;
    }
    if (!st.isSymbolicLink()) return current;
    current = resolve(dirname(current), readlinkSync(current));
  }
  throw new Error(`${path} is a chain of symbolic links with no end`);
}

export function writeAtomic(link: string, text: string, newFileMode = 0o600): void {
  const path = linkTarget(link);
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : newFileMode;
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.agentsocks-${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {}
    throw err;
  }
}

export function writeJsonObject(file: JsonFile, ctx: InstallContext, what: string): void {
  if (ctx.dryRun) {
    ctx.log.push(`${what} (dry run): would write ${file.path}`);
    return;
  }
  ctx.backup(file.path);
  writeAtomic(file.path, `${JSON.stringify(file.doc, null, 2)}\n`);
  ctx.log.push(`${what}: wrote ${file.path}`);
}

export function runsAgentsocks(entry: unknown, agent: InboxAgentId): boolean {
  if (!isRecord(entry) || typeof entry.command !== "string" || !Array.isArray(entry.args)) return false;
  const at = entry.args.indexOf("--agent");
  return entry.args.includes("mcp") && at !== -1 && entry.args[at + 1] === agent;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
