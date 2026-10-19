import { isAbsolute, join } from "node:path";
import { shellQuote, HOOK_MARKER } from "../files.ts";
import type { InstallContext } from "../types.ts";
import type { Plan } from "./yaml.ts";

export const HERMES_EVENTS = ["pre_llm_call", "pre_tool_call", "pre_verify", "on_session_end", "on_session_finalize"] as const;
export type HermesEvent = (typeof HERMES_EVENTS)[number];

export const TOOL_MATCHER = "^mcp_{1,2}agentsocks_{1,2}.*$";

export const PINNED = ["AGENTSOCKS_STATE_DIR", "AGENTSOCKS_RUNTIME_DIR", "AGENTSOCKS_CONFIG", "AGENTSOCKS_CCSOCKS_DIR", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR"] as const;

const quote = (s: string): string => JSON.stringify(s).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export function hermesHome(ctx: Pick<InstallContext, "home">, env: NodeJS.ProcessEnv = process.env): string {
  const set = env.HERMES_HOME?.trim();
  if (!set) return join(ctx.home, ".hermes");
  const expanded = set.replace(/^~(?=\/|$)/, ctx.home).replace(/\$(?:\{(\w+)\}|(\w+))/g, (_, a: string | undefined, b: string | undefined) => env[a ?? b ?? ""] ?? "");
  if (!isAbsolute(expanded)) throw new Error(`HERMES_HOME is "${set}", which is not an absolute path once ~ and $VARIABLES are expanded`);
  return expanded;
}

export const configFile = (home: string): string => join(home, "config.yaml");

export function pinnedEnv(env: NodeJS.ProcessEnv = process.env): [string, string][] {
  return PINNED.flatMap((name) => (env[name] ? [[name, env[name]!] as [string, string]] : []));
}

export function hookCommand(ctx: InstallContext, event: HermesEvent, env: NodeJS.ProcessEnv = process.env): string {
  const pins = pinnedEnv(env).map(([k, v]) => shellQuote(`${k}=${v}`));
  const [node, cli, ...words] = ctx.command("hook", "hermes", event);
  return ["env", HOOK_MARKER.trim(), ...pins, shellQuote(node!), shellQuote(cli!), ...words].join(" ");
}

export interface Wiring {
  plan: Plan;
  commands: { event: HermesEvent; command: string }[];
  node: string;
  cli: string;
}

export function wiring(ctx: InstallContext, env: NodeJS.ProcessEnv = process.env): Wiring {
  const [node, cli, ...mcp] = ctx.command("mcp", "--agent", "hermes");
  const pins = pinnedEnv(env);
  const server = [
    "agentsocks:",
    `  command: ${quote(node!)}`,
    `  args: [${[cli!, ...mcp].map(quote).join(", ")}]`,
    "  env:",
    '    NODE_NO_WARNINGS: "1"',
    ...pins.map(([k, v]) => `    ${k}: ${quote(v)}`),
  ];
  const commands = HERMES_EVENTS.map((event) => ({ event, command: hookCommand(ctx, event, env) }));
  const hooks = commands.map(({ event, command }) => ({
    event,
    item: [`- ${event === "pre_tool_call" ? `matcher: ${quote(TOOL_MATCHER)}\n  ` : ""}command: ${quote(command)}`, `  timeout: ${event === "on_session_finalize" ? 10 : 15}`].flatMap((s) => s.split("\n")),
  }));
  return { plan: { server, hooks }, commands, node: node!, cli: cli! };
}
