import { existsSync, lstatSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isOurCommand, isRecord, markedCommand, readJsonObject, runsAgentsocks, writeJsonObject, type JsonFile } from "../files.ts";
import type { AgentInstaller, AgentStatus, InstallContext } from "../types.ts";
import { HOOKS, SERVER_NAME, type HookDef } from "./events.ts";

const PINNED_VARIABLES = [
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "CLAUDE_CONFIG_DIR",
  "AGENTSOCKS_RUNTIME_DIR",
  "AGENTSOCKS_STATE_DIR",
  "AGENTSOCKS_CONFIG",
  "AGENTSOCKS_CCSOCKS_DIR",
  "AGENTSOCKS_CLAUDE_SESSIONS_DIR",
] as const;

type Env = NodeJS.ProcessEnv;

const configDir = (ctx: InstallContext, env: Env): string => (env.COPILOT_HOME ? resolve(env.COPILOT_HOME) : join(ctx.home, ".copilot"));
const mcpPath = (ctx: InstallContext, env: Env): string => join(configDir(ctx, env), "mcp-config.json");
const hooksPath = (ctx: InstallContext, env: Env): string => join(configDir(ctx, env), "hooks", "agentsocks.json");
const settingsPath = (ctx: InstallContext, env: Env): string => join(configDir(ctx, env), "settings.json");

// the MCP server gets only PATH and this block, and the hooks must agree with it on where the stamp key and the broker live
function pinnedEnv(ctx: InstallContext, env: Env): Record<string, string> {
  const pinned: Record<string, string> = { NODE_NO_WARNINGS: "1", HOME: ctx.home };
  for (const key of PINNED_VARIABLES) {
    const value = env[key];
    if (value) pinned[key] = value;
  }
  return pinned;
}

function serverEntry(ctx: InstallContext, env: Env): Record<string, unknown> {
  const [command = "", ...args] = ctx.command("mcp", "--agent", "copilot");
  return { type: "local", command, args, env: pinnedEnv(ctx, env), tools: ["*"] };
}

function hookEntry(ctx: InstallContext, env: Env, def: HookDef): Record<string, unknown> {
  return {
    type: "command",
    ...(def.matcher && { matcher: def.matcher }),
    bash: markedCommand(ctx, "copilot", def.event),
    env: pinnedEnv(ctx, env),
    timeoutSec: def.timeoutSec,
  };
}

const isOurHook = (entry: unknown): entry is Record<string, unknown> => isRecord(entry) && isOurCommand(entry.bash);

function serversOf(file: JsonFile): Record<string, unknown> {
  const value = file.doc.mcpServers;
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${file.path} has an mcpServers value that is not an object; left untouched`);
  return value;
}

function hooksOf(file: JsonFile): Record<string, unknown[]> {
  const { version, hooks = {} } = file.doc;
  if (version !== undefined && version !== 1) throw new Error(`${file.path} declares version ${String(version)} and Copilot CLI reads only version 1; left untouched`);
  if (!isRecord(hooks)) throw new Error(`${file.path} has a hooks value that is not an object; left untouched`);
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) throw new Error(`${file.path} lists hooks.${event} as something other than an array; left untouched`);
  }
  return hooks as Record<string, unknown[]>;
}

function holdsNothing(doc: Record<string, unknown>, container: string, ignore: string[] = []): boolean {
  const inner = doc[container];
  return Object.keys(doc).every((k) => k === container || ignore.includes(k)) && (!isRecord(inner) || Object.keys(inner).length === 0);
}

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

function removeFile(ctx: InstallContext, file: JsonFile, what: string, dirs: string[]): void {
  const path = file.path;
  if (isSymlink(path)) {
    writeJsonObject({ ...file, doc: {} }, ctx, `${what} (the link and the file it points to are kept)`);
    return;
  }
  if (ctx.dryRun) {
    ctx.log.push(`${what} (dry run): would remove ${path}`);
    return;
  }
  ctx.backup(path);
  unlinkSync(path);
  ctx.log.push(`${what}: removed ${path}`);
  for (const dir of dirs) {
    try {
      rmdirSync(dir);
    } catch {}
  }
}

function attempt(ctx: InstallContext, work: () => boolean | void): boolean {
  try {
    return work() === true;
  } catch (err) {
    ctx.log.push(`copilot: ${(err as Error).message}`);
    return false;
  }
}

const PULL_ONLY_NOTE =
  "copilot: pull-only: a session is told at its tool calls and before it finishes, never woken while idle. Copilot CLI asks before each MCP tool call; allow the agentsocks tools with --allow-tool=agentsocks or approve them once. Untested live.";

function installServer(ctx: InstallContext, env: Env): boolean {
  const file = readJsonObject(mcpPath(ctx, env));
  const servers = serversOf(file);
  const want = serverEntry(ctx, env);
  if (isDeepStrictEqual(servers[SERVER_NAME], want)) {
    ctx.log.push(`copilot: MCP server '${SERVER_NAME}' already in ${file.path}, unchanged`);
    return false;
  }
  const existed = Object.hasOwn(servers, SERVER_NAME);
  if (existed && !runsAgentsocks(servers[SERVER_NAME], "copilot")) throw new Error(`${file.path} already has a server named ${SERVER_NAME} that does not run agentsocks; left untouched. Rename or remove it, then install again`);
  servers[SERVER_NAME] = want;
  file.doc.mcpServers = servers;
  writeJsonObject(file, ctx, `copilot: ${existed ? "updated" : "added"} MCP server '${SERVER_NAME}'`);
  return true;
}

function installHooks(ctx: InstallContext, env: Env): boolean {
  const file = readJsonObject(hooksPath(ctx, env));
  const hooks = hooksOf(file);
  const changed: string[] = [];
  for (const def of HOOKS) {
    const list = hooks[def.event] ?? [];
    const want = hookEntry(ctx, env, def);
    const next: unknown[] = [];
    let placed = false;
    for (const existing of list) {
      if (!isOurHook(existing)) next.push(existing);
      else if (!placed) {
        next.push(want);
        placed = true;
      }
    }
    if (!placed) next.push(want);
    if (isDeepStrictEqual(next, list)) continue;
    hooks[def.event] = next;
    changed.push(def.event);
  }
  if (changed.length === 0) {
    ctx.log.push(`copilot: hooks already in ${file.path}, unchanged`);
    return false;
  }
  if (file.doc.version === undefined) file.doc = { version: 1, ...file.doc };
  file.doc.hooks = hooks;
  writeJsonObject(file, ctx, `copilot: hooks ${changed.join(", ")}`);
  return true;
}

function uninstallServer(ctx: InstallContext, env: Env): void {
  const path = mcpPath(ctx, env);
  if (!existsSync(path)) return;
  const file = readJsonObject(path);
  const servers = serversOf(file);
  if (!Object.hasOwn(servers, SERVER_NAME) || !runsAgentsocks(servers[SERVER_NAME], "copilot")) return;
  delete servers[SERVER_NAME];
  file.doc.mcpServers = servers;
  if (holdsNothing(file.doc, "mcpServers")) removeFile(ctx, file, `copilot: MCP server '${SERVER_NAME}'`, [configDir(ctx, env)]);
  else writeJsonObject(file, ctx, `copilot: removed MCP server '${SERVER_NAME}'`);
}

function uninstallHooks(ctx: InstallContext, env: Env): void {
  const path = hooksPath(ctx, env);
  if (!existsSync(path)) return;
  const file = readJsonObject(path);
  const hooks = hooksOf(file);
  const removed: string[] = [];
  for (const [event, list] of Object.entries(hooks)) {
    const kept = list.filter((entry) => !isOurHook(entry));
    if (kept.length === list.length) continue;
    removed.push(event);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (removed.length === 0) return;
  file.doc.hooks = hooks;
  if (holdsNothing(file.doc, "hooks", ["version"])) removeFile(ctx, file, `copilot: hooks ${removed.join(", ")}`, [dirname(path), configDir(ctx, env)]);
  else writeJsonObject(file, ctx, `copilot: removed hooks ${removed.join(", ")}`);
}

function mcpProblem(ctx: InstallContext, env: Env): { present: boolean; problem?: string } {
  const file = readJsonObject(mcpPath(ctx, env));
  const entry = serversOf(file)[SERVER_NAME];
  if (entry === undefined) return { present: false, problem: `MCP server '${SERVER_NAME}' is missing from ${file.path}` };
  const [command, ...args] = ctx.command("mcp", "--agent", "copilot");
  const current = isRecord(entry) && entry.command === command && isDeepStrictEqual(entry.args, args);
  return current ? { present: true } : { present: true, problem: `MCP server '${SERVER_NAME}' in ${file.path} points at another install; run agentsocks install --copilot` };
}

function hookProblem(ctx: InstallContext, def: HookDef, hooks: Record<string, unknown[]>): { present: boolean; problem?: string } {
  const ours = (hooks[def.event] ?? []).filter(isOurHook);
  if (ours.length === 0) return { present: false, problem: `${def.event} hook is missing` };
  const current = ours.some((e) => e.bash === markedCommand(ctx, "copilot", def.event) && e.matcher === def.matcher);
  return current ? { present: true } : { present: true, problem: `${def.event} hook points at another install; run agentsocks install --copilot` };
}

function hooksDisabled(ctx: InstallContext, env: Env): boolean {
  try {
    return readJsonObject(settingsPath(ctx, env)).doc.disableAllHooks === true;
  } catch {
    return false;
  }
}

function status(ctx: InstallContext, env: Env, detected: boolean): AgentStatus {
  if (!detected) return { state: "not installed", detail: [] };
  const checks: { present: boolean; problem?: string }[] = [];
  const unreadable: string[] = [];
  const check = (work: () => { present: boolean; problem?: string }[]): void => {
    try {
      checks.push(...work());
    } catch (err) {
      unreadable.push((err as Error).message.replace(/;.*$/, ""));
    }
  };
  check(() => [mcpProblem(ctx, env)]);
  check(() => {
    const hooks = hooksOf(readJsonObject(hooksPath(ctx, env)));
    return HOOKS.map((def) => hookProblem(ctx, def, hooks));
  });
  const problems = [...checks.flatMap((c) => (c.problem ? [c.problem] : [])), ...unreadable];
  if (checks.every((c) => !c.present) && unreadable.length === 0) return { state: "not wired", detail: [] };
  if (hooksDisabled(ctx, env)) problems.push("disableAllHooks is true in settings.json, so Copilot CLI runs none of the hooks");
  if (problems.length > 0) return { state: "partly wired", detail: problems };
  return { state: "wired", detail: ["pull-only: told at tool calls and before it finishes, never woken while idle"] };
}

export function copilotInstaller(env: Env = process.env): AgentInstaller {
  const detect = (ctx: InstallContext): boolean => existsSync(configDir(ctx, env));
  return {
    detect,
    install(ctx) {
      const wrote = [attempt(ctx, () => installServer(ctx, env)), attempt(ctx, () => installHooks(ctx, env))];
      if (wrote.includes(true)) ctx.log.push(PULL_ONLY_NOTE);
    },
    uninstall(ctx) {
      attempt(ctx, () => uninstallServer(ctx, env));
      attempt(ctx, () => uninstallHooks(ctx, env));
    },
    status: (ctx) => status(ctx, env, detect(ctx)),
  };
}
