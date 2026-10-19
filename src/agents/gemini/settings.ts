import { join } from "node:path";
import { isOurCommand, isRecord, markedCommand, runsAgentsocks } from "../files.ts";
import type { InstallContext } from "../types.ts";

export const SERVER = "agentsocks";
export const TOOL_PREFIX = `mcp_${SERVER}_`;

export type GeminiEvent = "SessionStart" | "BeforeTool" | "AfterTool" | "AfterAgent" | "SessionEnd";

interface WiredHook {
  event: GeminiEvent;
  name: string;
  matcher: string;
  timeout: number;
}

const WIRED: readonly WiredHook[] = [
  { event: "SessionStart", name: "agentsocks-session-start", matcher: "*", timeout: 10_000 },
  { event: "BeforeTool", name: "agentsocks-stamp", matcher: `^${TOOL_PREFIX}`, timeout: 10_000 },
  { event: "AfterTool", name: "agentsocks-notice", matcher: "*", timeout: 10_000 },
  { event: "AfterAgent", name: "agentsocks-finish", matcher: "*", timeout: 10_000 },
  { event: "SessionEnd", name: "agentsocks-session-end", matcher: "*", timeout: 3_000 },
];

type Doc = Record<string, unknown>;

interface HookConfig {
  name: string;
  type: "command";
  command: string;
  timeout: number;
}

export interface Wiring {
  server: { command: string; args: string[]; env: Record<string, string> };
  hooks: readonly { event: GeminiEvent; matcher: string; config: HookConfig }[];
}

export const geminiDir = (home: string, env: NodeJS.ProcessEnv = process.env): string => join(env.GEMINI_CLI_HOME || home, ".gemini");

export const settingsPath = (home: string, env: NodeJS.ProcessEnv = process.env): string => join(geminiDir(home, env), "settings.json");

export function wiringFor(ctx: InstallContext): Wiring {
  const [command = "", ...args] = ctx.command("mcp", "--agent", "gemini");
  const hooks = WIRED.map((h) => ({ event: h.event, matcher: h.matcher, config: { name: h.name, type: "command" as const, command: markedCommand(ctx, "gemini", h.event), timeout: h.timeout } }));
  if ([command, ...args, ...hooks.map((h) => h.config.command)].some((s) => s.includes("$"))) {
    throw new Error("the node or agentsocks path contains a $, which Gemini CLI expands inside settings.json, so the entries would not run; install agentsocks under a path without one");
  }
  return { server: { command, args, env: { NODE_NO_WARNINGS: "1" } }, hooks };
}

function section(parent: Doc, key: string, create: boolean): Doc | undefined {
  const value = parent[key];
  if (value === undefined) return create ? (parent[key] = {}) as Doc : undefined;
  if (!isRecord(value)) throw new Error(`"${key}" is not an object`);
  return value;
}

function definitions(hooks: Doc, event: string, create: boolean): unknown[] | undefined {
  const value = hooks[event];
  if (value === undefined) return create ? (hooks[event] = []) as unknown[] : undefined;
  if (!Array.isArray(value)) throw new Error(`hooks.${event} is not an array`);
  return value;
}

interface Located {
  definition: Doc & { hooks: unknown[] };
  hook: Doc;
}

const isDefinition = (v: unknown): v is Doc & { hooks: unknown[] } => isRecord(v) && Array.isArray(v.hooks);

function locate(defs: unknown[] | undefined): Located | undefined {
  for (const definition of defs ?? []) {
    if (!isDefinition(definition)) continue;
    const index = definition.hooks.findIndex((h) => isRecord(h) && isOurCommand(h.command));
    if (index !== -1) return { definition, hook: definition.hooks[index] as Doc };
  }
  return undefined;
}

const ownsDefinition = (d: Located["definition"]): boolean => d.hooks.every((h) => isRecord(h) && isOurCommand(h.command));

const sameArgs = (a: unknown, b: string[]): boolean => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

function serverCurrent(current: unknown, want: Wiring["server"]): boolean {
  if (!isRecord(current) || current.command !== want.command || !sameArgs(current.args, want.args)) return false;
  return isRecord(current.env) && Object.entries(want.env).every(([k, v]) => (current.env as Doc)[k] === v);
}

function hookCurrent(found: Located, want: Wiring["hooks"][number]): boolean {
  const { hook, definition } = found;
  const hookOk = (Object.keys(want.config) as (keyof HookConfig)[]).every((k) => hook[k] === want.config[k]);
  return hookOk && (!ownsDefinition(definition) || definition.matcher === want.matcher);
}

export function applyWiring(doc: Doc, wiring: Wiring): string[] {
  const changes: string[] = [];
  const servers = section(doc, "mcpServers", false);
  const current = servers?.[SERVER];
  if (current !== undefined && !runsAgentsocks(current, "gemini")) throw new Error(`settings.json already has a server named ${SERVER} that does not run agentsocks; left untouched. Rename or remove it, then install again`);
  if (!serverCurrent(current, wiring.server)) {
    const env = isRecord(current) && isRecord(current.env) ? current.env : {};
    (servers ?? section(doc, "mcpServers", true)!)[SERVER] = { ...(isRecord(current) ? current : {}), ...wiring.server, env: { ...env, ...wiring.server.env } };
    changes.push(current === undefined ? "added the MCP server" : "updated the MCP server");
  }
  for (const want of wiring.hooks) {
    const hooks = section(doc, "hooks", false);
    const defs = hooks && definitions(hooks, want.event, false);
    const found = locate(defs);
    if (found && hookCurrent(found, want)) continue;
    if (found) {
      Object.assign(found.hook, want.config);
      if (ownsDefinition(found.definition)) found.definition.matcher = want.matcher;
      changes.push(`updated the ${want.event} hook`);
      continue;
    }
    definitions(hooks ?? section(doc, "hooks", true)!, want.event, true)!.push({ matcher: want.matcher, hooks: [{ ...want.config }] });
    changes.push(`added the ${want.event} hook`);
  }
  return changes;
}

export function removeWiring(doc: Doc): string[] {
  const changes: string[] = [];
  const servers = section(doc, "mcpServers", false);
  if (servers && SERVER in servers && runsAgentsocks(servers[SERVER], "gemini")) {
    delete servers[SERVER];
    changes.push("removed the MCP server");
    if (Object.keys(servers).length === 0) delete doc.mcpServers;
  }
  const hooks = section(doc, "hooks", false);
  let touched = false;
  for (const event of Object.keys(hooks ?? {})) {
    const defs = hooks![event];
    if (!Array.isArray(defs)) continue;
    let removed = 0;
    const kept = defs.filter((def) => {
      if (!isDefinition(def)) return true;
      const before = def.hooks.length;
      def.hooks = def.hooks.filter((h) => !(isRecord(h) && isOurCommand(h.command)));
      removed += before - def.hooks.length;
      return def.hooks.length > 0 || before === 0;
    });
    if (removed === 0) continue;
    touched = true;
    changes.push(`removed the ${event} hook`);
    if (kept.length > 0) hooks![event] = kept;
    else delete hooks![event];
  }
  if (touched && hooks && Object.keys(hooks).length === 0) delete doc.hooks;
  return changes;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function blockers(doc: Doc): string[] {
  const out: string[] = [];
  const hooksConfig = isRecord(doc.hooksConfig) ? doc.hooksConfig : {};
  const hooks = isRecord(doc.hooks) ? doc.hooks : {};
  if (hooksConfig.enabled === false) out.push("hooksConfig.enabled is false, so Gemini CLI runs no hooks");
  const disabled = new Set([...strings(hooksConfig.disabled), ...strings(hooks.disabled)]);
  const off = WIRED.filter((h) => disabled.has(h.name)).map((h) => h.name);
  if (off.length > 0) out.push(`Gemini CLI has these agentsocks hooks switched off: ${off.join(", ")}`);
  const mcp = isRecord(doc.mcp) ? doc.mcp : {};
  if (strings(mcp.excluded).includes(SERVER)) out.push(`mcp.excluded lists ${SERVER}, so Gemini CLI will not start it`);
  if (Array.isArray(mcp.allowed) && !strings(mcp.allowed).includes(SERVER)) out.push(`mcp.allowed does not list ${SERVER}, so Gemini CLI will not start it`);
  return out;
}

export interface Inspection {
  present: number;
  missing: string[];
  stale: string[];
}

export function inspect(doc: Doc, wiring: Wiring): Inspection {
  const result: Inspection = { present: 0, missing: [], stale: [] };
  const note = (label: string, current: boolean | undefined) => {
    if (current === undefined) result.missing.push(label);
    else {
      result.present++;
      if (!current) result.stale.push(label);
    }
  };
  const servers = isRecord(doc.mcpServers) ? doc.mcpServers : {};
  note("MCP server", servers[SERVER] === undefined ? undefined : serverCurrent(servers[SERVER], wiring.server));
  const hooks = isRecord(doc.hooks) ? doc.hooks : {};
  for (const want of wiring.hooks) {
    const defs = hooks[want.event];
    const found = locate(Array.isArray(defs) ? defs : undefined);
    note(`${want.event} hook`, found ? hookCurrent(found, want) : undefined);
  }
  return result;
}
