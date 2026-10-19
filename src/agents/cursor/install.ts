import { existsSync, lstatSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOOK_MARKER, isOurCommand, isRecord, readJsonObject, shellQuote, writeJsonObject } from "../files.ts";
import type { AgentInstaller, AgentStatus, InstallContext } from "../types.ts";
import { CURSOR_HOOKS, type CursorEvent } from "./hooks.ts";

const SERVER = "agentsocks";
const PULL_ONLY = "pull-only: an idle Cursor chat is told at its next tool call and at the end of its turn, and cannot be woken";
const EVENTS = Object.keys(CURSOR_HOOKS) as CursorEvent[];

const PINNED = [
  "AGENTSOCKS_STATE_DIR",
  "AGENTSOCKS_RUNTIME_DIR",
  "AGENTSOCKS_CONFIG",
  "AGENTSOCKS_CCSOCKS_DIR",
  "AGENTSOCKS_CLAUDE_SESSIONS_DIR",
  "AGENTSOCKS_CLAUDE_PROJECTS_DIR",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "CLAUDE_CONFIG_DIR",
];

type Doc = Record<string, unknown>;
type Env = Readonly<Record<string, string | undefined>>;
type Entry = Doc;

const locate = (home: string) => ({ dir: join(home, ".cursor"), mcp: join(home, ".cursor", "mcp.json"), hooks: join(home, ".cursor", "hooks.json"), claude: join(home, ".claude", "settings.json") });

function executable(ctx: InstallContext): { node: string; cli: string } {
  const [node = "", cli = ""] = ctx.command();
  return { node, cli };
}

function pins(env: Env): [string, string][] {
  const set = PINNED.flatMap((name): [string, string][] => (env[name] ? [[name, env[name]]] : []));
  return [["NODE_NO_WARNINGS", "1"], ...set];
}

const hookSuffix = (ctx: InstallContext, event: CursorEvent): string => ctx.command("hook", "cursor", event).map(shellQuote).join(" ");

function hookEntry(ctx: InstallContext, env: Env, event: CursorEvent): Entry {
  const { timeout, matcher, loop_limit } = CURSOR_HOOKS[event];
  const assignments = pins(env).map(([name, value]) => `${name}=${shellQuote(value)}`);
  return { command: `${HOOK_MARKER}${[...assignments, hookSuffix(ctx, event)].join(" ")}`, timeout, ...(matcher !== undefined && { matcher }), ...(loop_limit !== undefined && { loop_limit }) };
}

function serverEntry(ctx: InstallContext, env: Env): Entry {
  const { node, cli } = executable(ctx);
  return { type: "stdio", command: node, args: [cli, "mcp", "--agent", "cursor"], env: Object.fromEntries(pins(env)) };
}

interface LocalServer extends Doc {
  command: string;
  args: unknown[];
}

const runsLocalAgentsocks = (entry: unknown): entry is LocalServer => isRecord(entry) && typeof entry.command === "string" && Array.isArray(entry.args) && entry.args.includes("mcp");

const isOurHook = (entry: unknown): boolean => isRecord(entry) && isOurCommand(entry.command) && (entry.command as string).includes("'hook' 'cursor' ");

const sameList = (a: unknown, b: readonly unknown[]): boolean => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

function hookIsCurrent(entry: Entry, ctx: InstallContext, event: CursorEvent): boolean {
  const { timeout, matcher, loop_limit } = CURSOR_HOOKS[event];
  return (entry.command as string).endsWith(hookSuffix(ctx, event)) && entry.timeout === timeout && entry.matcher === matcher && entry.loop_limit === loop_limit;
}

function shapeError(path: string, key: string): Error {
  return new Error(`${path} has a "${key}" that is not what Cursor documents; left untouched`);
}

function addServer(doc: Doc, path: string, entry: Entry): void {
  const servers = doc.mcpServers ?? {};
  if (!isRecord(servers)) throw shapeError(path, "mcpServers");
  if (SERVER in servers && !runsLocalAgentsocks(servers[SERVER])) throw new Error(`${path} already has a server named ${SERVER} that does not run a local agentsocks command; left untouched. Rename or remove it, then install again`);
  doc.mcpServers = { ...servers, [SERVER]: entry };
}

function removeServer(doc: Doc): void {
  const servers = doc.mcpServers;
  if (!isRecord(servers) || !runsLocalAgentsocks(servers[SERVER])) return;
  const rest = { ...servers };
  delete rest[SERVER];
  if (Object.keys(rest).length > 0) doc.mcpServers = rest;
  else delete doc.mcpServers;
}

function addHooks(doc: Doc, path: string, entries: Record<CursorEvent, Entry>): void {
  const hooks = doc.hooks ?? {};
  if (!isRecord(hooks)) throw shapeError(path, "hooks");
  const next: Doc = { ...hooks };
  for (const event of EVENTS) {
    const current = next[event] ?? [];
    if (!Array.isArray(current)) throw shapeError(path, `hooks.${event}`);
    let placed = false;
    const list: unknown[] = [];
    for (const item of current) {
      if (!isOurHook(item)) list.push(item);
      else if (!placed) {
        list.push(entries[event]);
        placed = true;
      }
    }
    if (!placed) list.push(entries[event]);
    next[event] = list;
  }
  doc.version ??= 1;
  doc.hooks = next;
}

function removeHooks(doc: Doc): void {
  const hooks = doc.hooks;
  if (!isRecord(hooks)) return;
  const next: Doc = {};
  let removed = false;
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list) || !list.some(isOurHook)) {
      next[event] = list;
      continue;
    }
    removed = true;
    const kept = list.filter((item) => !isOurHook(item));
    if (kept.length > 0) next[event] = kept;
  }
  if (!removed) return;
  if (Object.keys(next).length > 0) doc.hooks = next;
  else delete doc.hooks;
}

function removeFile(ctx: InstallContext, path: string): void {
  if (ctx.dryRun) {
    ctx.log.push(`cursor (dry run): would remove ${path}`);
    return;
  }
  ctx.backup(path);
  unlinkSync(path);
  ctx.log.push(`cursor: removed ${path}`);
  try {
    rmdirSync(dirname(path));
  } catch {}
}

function install(ctx: InstallContext, path: string, change: (doc: Doc) => void): void {
  try {
    const file = readJsonObject(path);
    const before = JSON.stringify(file.doc);
    change(file.doc);
    if (file.existed && JSON.stringify(file.doc) === before) ctx.log.push(`cursor: ${path} unchanged`);
    else writeJsonObject(file, ctx, "cursor");
  } catch (err) {
    ctx.log.push(`cursor: ${(err as Error).message}`);
  }
}

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

// A file left with only what a fresh install creates is removed, so install then uninstall leaves no trace; a symlinked file is written through, never unlinked.
function uninstall(ctx: InstallContext, path: string, change: (doc: Doc) => void, isScaffold: (doc: Doc) => boolean): void {
  try {
    const file = readJsonObject(path);
    if (!file.existed) return;
    const before = JSON.stringify(file.doc);
    change(file.doc);
    if (JSON.stringify(file.doc) === before) return;
    if (isScaffold(file.doc) && !isSymlink(path)) removeFile(ctx, path);
    else writeJsonObject(file, ctx, "cursor");
  } catch (err) {
    ctx.log.push(`cursor: ${(err as Error).message}`);
  }
}

function peek(path: string): Doc | "invalid" | undefined {
  try {
    const file = readJsonObject(path);
    return file.existed ? file.doc : undefined;
  } catch {
    return "invalid";
  }
}

const containsOurCommand = (value: unknown): boolean =>
  Array.isArray(value) ? value.some(containsOurCommand) : isRecord(value) ? Object.entries(value).some(([key, v]) => (key === "command" && isOurCommand(v)) || containsOurCommand(v)) : false;

function listFor(doc: Doc | "invalid" | undefined, event: CursorEvent): unknown[] {
  const hooks = doc && doc !== "invalid" ? doc.hooks : undefined;
  const list = isRecord(hooks) ? hooks[event] : undefined;
  return Array.isArray(list) ? list : [];
}

interface Audit {
  found: number;
  problems: string[];
  repairable: boolean;
  unreadable: boolean;
}

function auditServer(ctx: InstallContext, path: string, env: Env): Audit {
  const doc = peek(path);
  if (doc === "invalid") return { found: 0, problems: ["~/.cursor/mcp.json is not valid JSON"], repairable: false, unreadable: true };
  const server = doc && isRecord(doc.mcpServers) ? doc.mcpServers[SERVER] : undefined;
  if (server === undefined) return { found: 0, problems: ["~/.cursor/mcp.json has no agentsocks server"], repairable: true, unreadable: false };
  if (!runsLocalAgentsocks(server)) return { found: 0, problems: ["~/.cursor/mcp.json has a server named agentsocks that does not run a local agentsocks command, so install leaves it alone"], repairable: false, unreadable: false };
  const { node, cli } = executable(ctx);
  const drifted = PINNED.filter((name) => env[name] && isRecord(server.env) && typeof server.env[name] === "string" && server.env[name] !== env[name]);
  const problems: string[] = [];
  if (server.command !== node || !sameList(server.args, [cli, "mcp", "--agent", "cursor"])) {
    const started = server.args[0];
    problems.push(typeof started === "string" && started !== cli ? `~/.cursor/mcp.json starts ${started}, not ${cli}` : "~/.cursor/mcp.json has an agentsocks server that is not the one this install runs");
  }
  if (drifted.length > 0) problems.push(`~/.cursor/mcp.json pins ${drifted.join(", ")} to other values than this shell has, so the hooks and this shell would use different state`);
  return { found: 1, problems, repairable: problems.length > 0, unreadable: false };
}

function auditHooks(ctx: InstallContext, path: string): Audit {
  const doc = peek(path);
  if (doc === "invalid") return { found: 0, problems: ["~/.cursor/hooks.json is not valid JSON"], repairable: false, unreadable: true };
  const missing: CursorEvent[] = [];
  const stale: CursorEvent[] = [];
  const repeated: CursorEvent[] = [];
  for (const event of EVENTS) {
    const ours = listFor(doc, event).filter(isOurHook);
    if (ours.length === 0) missing.push(event);
    else if (!ours.every((entry) => hookIsCurrent(entry as Entry, ctx, event))) stale.push(event);
    if (ours.length > 1) repeated.push(event);
  }
  const problems = [
    ...(missing.length > 0 ? [`~/.cursor/hooks.json has no ${missing.join(", ")} hook${missing.length > 1 ? "s" : ""}`] : []),
    ...(stale.length > 0 ? [`~/.cursor/hooks.json is out of date for ${stale.join(", ")}`] : []),
    ...(repeated.length > 0 ? [`~/.cursor/hooks.json has more than one agentsocks hook for ${repeated.join(", ")}`] : []),
  ];
  return { found: EVENTS.length - missing.length, problems, repairable: problems.length > 0, unreadable: false };
}

export function createCursorInstaller(env: Env = process.env): AgentInstaller {
  const detect = (ctx: InstallContext): boolean => existsSync(locate(ctx.home).dir) || ctx.hasBinary("cursor-agent");

  return {
    detect,

    install(ctx) {
      const at = locate(ctx.home);
      if (env.CURSOR_CONFIG_DIR) ctx.log.push(`cursor: CURSOR_CONFIG_DIR is set, but Cursor documents it for cli-config.json only, so mcp.json and hooks.json were written under ${at.dir}`);
      const entries = Object.fromEntries(EVENTS.map((event) => [event, hookEntry(ctx, env, event)])) as Record<CursorEvent, Entry>;
      install(ctx, at.mcp, (doc) => addServer(doc, at.mcp, serverEntry(ctx, env)));
      install(ctx, at.hooks, (doc) => addHooks(doc, at.hooks, entries));
    },

    uninstall(ctx) {
      const at = locate(ctx.home);
      uninstall(ctx, at.mcp, removeServer, (doc) => Object.keys(doc).length === 0);
      uninstall(ctx, at.hooks, removeHooks, (doc) => Object.keys(doc).every((key) => key === "version"));
    },

    status(ctx): AgentStatus {
      if (!detect(ctx)) return { state: "not installed", detail: [] };
      const at = locate(ctx.home);
      const audits = [auditServer(ctx, at.mcp, env), auditHooks(ctx, at.hooks)];
      const claude = peek(at.claude);
      const double = claude !== undefined && claude !== "invalid" && containsOurCommand(claude.hooks);
      const found = audits.reduce((n, a) => n + a.found, 0);
      const unreadable = audits.some((a) => a.unreadable);
      if (found === 0 && !unreadable && !double) return { state: "not wired", detail: [] };
      const problems = [
        ...audits.flatMap((a) => a.problems),
        ...(audits.some((a) => a.repairable) ? ["run `agentsocks install --cursor` to repair it"] : []),
        ...(double ? ["~/.claude/settings.json also holds an agentsocks hook, and Cursor loads that file too, so the hook would run twice; remove it there (agentsocks never edits ~/.claude) or turn off Cursor's Third-Party Imports setting"] : []),
      ];
      return problems.length === 0 ? { state: "wired", detail: [PULL_ONLY] } : { state: "partly wired", detail: problems };
    },
  };
}

export const cursorInstaller: AgentInstaller = createCursorInstaller();
