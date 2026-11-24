import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentInstaller, AgentStatus, InstallContext } from "../types.ts";
import { isRecord, writeAtomic } from "../files.ts";
import { configFile, hermesHome, HERMES_EVENTS, pinnedEnv, wiring } from "./config.ts";
import { consentFor, consentInstruction } from "./consent.ts";
import { PLUGIN_FILES, PLUGIN_MARKER, PLUGIN_NAME, pluginFiles, type PluginFile } from "./plugin.ts";
import { describeWake, pluginDir, wakeConfig } from "./wake.ts";
import { addManaged, inspectManaged, removeManaged } from "./yaml.ts";

const norm = (s: string): string => s.replace(/\s+/g, " ");

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

const PARSE = "import sys, json\ntry:\n  import yaml\nexcept ImportError:\n  sys.exit(3)\nprint(json.dumps(yaml.safe_load(sys.stdin.read()), default=str))";

type Parsed = { ok: true; doc: unknown } | { ok: false } | undefined;

function parseYaml(text: string): Parsed {
  const r = spawnSync("python3", ["-I", "-c", PARSE], { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status === 3) return undefined;
  if (r.status !== 0) return { ok: false };
  try {
    return { ok: true, doc: JSON.parse(r.stdout) as unknown };
  } catch {
    return undefined;
  }
}

const OUR_HOOK = /^env AGENTSOCKS_HOOK=1 .* hook hermes [a-z_]+$/;

// The document as Hermes reads it, minus everything agentsocks wrote, with keys sorted. Two files that differ
// only in agentsocks entries give the same string.
function foreignOnly(parsed: unknown): string {
  const doc = parsed ?? {}; // an empty file reads as null, and as {} once our keys are taken out again
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted) : isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
  if (!isRecord(doc)) return JSON.stringify(sorted(doc));
  const copy: Record<string, unknown> = { ...doc };
  if (isRecord(copy.mcp_servers)) {
    const { agentsocks: _ours, ...rest } = copy.mcp_servers;
    if (Object.keys(rest).length === 0) delete copy.mcp_servers;
    else copy.mcp_servers = rest;
  } else if (copy.mcp_servers === null) delete copy.mcp_servers;
  if (isRecord(copy.hooks)) {
    const rest: Record<string, unknown> = {};
    for (const [event, list] of Object.entries(copy.hooks)) {
      const kept = Array.isArray(list) ? list.filter((h) => !(isRecord(h) && typeof h.command === "string" && OUR_HOOK.test(h.command))) : list;
      if (!(Array.isArray(kept) && kept.length === 0) && kept !== null) rest[event] = kept;
    }
    if (Object.keys(rest).length === 0) delete copy.hooks;
    else copy.hooks = rest;
  } else if (copy.hooks === null) delete copy.hooks;
  return JSON.stringify(sorted(copy));
}

// Refuses a write that would change anything agentsocks did not write, as a YAML reader sees it. Without
// python3 and PyYAML the check cannot run and the text editor's own guards are all there is.
function guard(path: string, before: string, after: string): void {
  if (after === before) return;
  const a = parseYaml(before);
  if (a?.ok === false) return; // a file that does not parse now is judged by the editor alone, as before
  const b = parseYaml(after);
  if (b?.ok === false) throw new Error(`${path}: the edited file would not be valid YAML; left untouched`);
  if (a?.ok && b?.ok && foreignOnly(a.doc) !== foreignOnly(b.doc)) throw new Error(`${path}: the edit would change entries agentsocks did not write; left untouched`);
}

const eventsLine = HERMES_EVENTS.join(", ");

const INJECTION_KEY = `plugins.entries.${PLUGIN_NAME}.allow_gateway_injection`;
const ENABLE = ["plugins", "enable", PLUGIN_NAME];
const ALLOW = ["config", "set", INJECTION_KEY, "true"];
const DISABLE = ["plugins", "disable", PLUGIN_NAME];
const DISALLOW = ["config", "unset", INJECTION_KEY];
const HERMES_CLI_MS = 60_000;

const isPlugin = (text: string | undefined): boolean => text !== undefined && text.startsWith(PLUGIN_MARKER);

function wantedPlugin(ctx: InstallContext): Record<PluginFile, string> {
  const [node, cli] = ctx.command();
  return pluginFiles({ node: node!, cli: cli!, pinned: pinnedEnv() });
}

interface PluginSettings {
  enabled: boolean;
  allowed: boolean;
}

// What Hermes's config says about the plugin, or undefined when it cannot be read (no python3 with PyYAML).
function pluginSettings(text: string): PluginSettings | undefined {
  const parsed = parseYaml(text);
  if (!parsed?.ok) return undefined;
  const plugins = isRecord(parsed.doc) && isRecord(parsed.doc.plugins) ? parsed.doc.plugins : {};
  const listed = (key: string): boolean => Array.isArray(plugins[key]) && (plugins[key] as unknown[]).includes(PLUGIN_NAME);
  const entry = isRecord(plugins.entries) && isRecord(plugins.entries[PLUGIN_NAME]) ? plugins.entries[PLUGIN_NAME] : {};
  return { enabled: listed("enabled") && !listed("disabled"), allowed: entry.allow_gateway_injection === true };
}

// Hermes owns plugins.enabled and plugins.entries, so they change through its own CLI. Without it, or when it
// fails, the log names the commands to run.
function runHermes(ctx: InstallContext, home: string, steps: string[][], unless: string): void {
  if (steps.length === 0) return;
  const shown = (args: string[]): string => `\`${process.env.HERMES_HOME?.trim() ? `HERMES_HOME=${home} ` : ""}hermes ${args.join(" ")}\``;
  if (ctx.dryRun) {
    ctx.log.push(`hermes (dry run): would run ${steps.map(shown).join(", then ")}`);
    return;
  }
  if (!ctx.hasBinary("hermes")) {
    ctx.log.push(`hermes: the hermes command is not on the PATH; ${unless} run ${steps.map(shown).join(", then ")}`);
    return;
  }
  for (const [i, args] of steps.entries()) {
    const run = spawnSync("hermes", args, { env: { ...process.env, HERMES_HOME: home }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: HERMES_CLI_MS });
    if (run.status !== 0) {
      const why = run.error ? `could not run (${run.error.message})` : `exited with ${run.status ?? run.signal}`;
      ctx.log.push(`hermes: ${shown(args)} ${why}; ${unless} run ${steps.slice(i).map(shown).join(", then ")}`);
      return;
    }
    ctx.log.push(`hermes: ran ${shown(args)}`);
  }
}

function writePlugin(ctx: InstallContext, dir: string, files: Record<PluginFile, string>): boolean {
  const changed = PLUGIN_FILES.filter((name) => readText(join(dir, name)) !== files[name]);
  if (changed.length === 0) {
    ctx.log.push(`hermes: plugin ${dir} already installed, unchanged`);
  } else if (ctx.dryRun) {
    ctx.log.push(`hermes (dry run): would write the agentsocks plugin to ${dir}`);
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of changed) {
      const path = join(dir, name);
      if (existsSync(path)) ctx.backup(path);
      writeAtomic(path, files[name]);
    }
    ctx.log.push(`hermes: wrote the agentsocks plugin to ${dir}`);
  }
  return changed.length > 0;
}

function removePlugin(ctx: InstallContext, home: string): void {
  const dir = pluginDir(home);
  const ours = PLUGIN_FILES.map((name) => join(dir, name)).filter((path) => isPlugin(readText(path)));
  if (ours.length === 0) return;
  const settings = pluginSettings(readText(configFile(home)) ?? "");
  runHermes(ctx, home, [...(settings?.enabled === false ? [] : [DISABLE]), ...(settings?.allowed === false ? [] : [DISALLOW])], "to take the plugin out of Hermes's config,");
  if (ctx.dryRun) {
    ctx.log.push(`hermes (dry run): would remove ${ours.join(", ")}`);
    return;
  }
  for (const path of ours) {
    ctx.backup(path);
    unlinkSync(path);
  }
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {}
  ctx.log.push(`hermes: removed the agentsocks plugin from ${dir}`);
}

function pluginReport(ctx: InstallContext, home: string, configText: string): { current: boolean; lines: string[] } {
  const dir = pluginDir(home);
  const found = PLUGIN_FILES.map((name) => readText(join(dir, name)));
  if (found.every((text) => text === undefined)) return { current: false, lines: [`the agentsocks plugin is not in ${dir}, so idle chats are not woken; run \`agentsocks install --hermes\``] };
  if (found.some((text) => text !== undefined && !isPlugin(text))) return { current: false, lines: [`${dir} holds files agentsocks did not write, so the agentsocks plugin is not installed`] };
  const wanted = wantedPlugin(ctx);
  if (PLUGIN_FILES.some((name, i) => found[i] !== wanted[name])) return { current: false, lines: [`the agentsocks plugin in ${dir} is incomplete, out of date or points at another agentsocks install; run \`agentsocks install --hermes\``] };
  const settings = pluginSettings(configText);
  if (!settings) return { current: true, lines: [`plugin ${dir} is installed; whether Hermes enables it could not be checked without python3 and PyYAML`] };
  const lines: string[] = [];
  if (!settings.enabled) lines.push(`the agentsocks plugin is not enabled, so idle chats are not woken; run \`hermes plugins enable ${PLUGIN_NAME}\``);
  if (!settings.allowed) lines.push(`the agentsocks plugin may not start turns; run \`hermes config set ${INJECTION_KEY} true\``);
  if (lines.length === 0) lines.push(`plugin ${dir} is enabled and may start turns: a message wakes an idle chat open in a running Hermes`);
  return { current: true, lines };
}

function install(ctx: InstallContext): void {
  const home = hermesHome(ctx);
  const path = configFile(home);
  const dir = pluginDir(home);
  for (const name of PLUGIN_FILES) {
    const text = readText(join(dir, name));
    if (text !== undefined && !isPlugin(text)) throw new Error(`${join(dir, name)} exists and is not part of the agentsocks plugin; left untouched`);
  }
  const before = readText(path) ?? "";
  const w = wiring(ctx);
  const edit = addManaged(before, w.plan);
  if (!edit.ok) throw new Error(`${path}: ${edit.reason}; left untouched`);
  guard(path, before, edit.text);
  for (const kept of edit.rescued) ctx.log.push(`hermes: kept ${kept} in ${path}, and moved it out of the agentsocks block`);
  if (edit.adopted > 0) ctx.log.push(`hermes: ${edit.adopted} agentsocks entr${edit.adopted === 1 ? "y" : "ies"} in ${path} had lost their comment markers (Hermes may have rewritten the file), and were written again with them`);
  for (const skipped of edit.skipped) ctx.log.push(`hermes: ${skipped} is already in ${path} and is not one agentsocks wrote, so it was left as it is`);
  if (edit.text === before) {
    ctx.log.push(`hermes: agentsocks entries already present in ${path}, unchanged`);
  } else if (ctx.dryRun) {
    ctx.log.push(`hermes (dry run): would write ${path}: mcp_servers.agentsocks and shell hooks for ${eventsLine}`);
  } else {
    if (existsSync(path)) ctx.backup(path);
    writeAtomic(path, edit.text);
    ctx.log.push(`hermes: wired ${path}: mcp_servers.agentsocks and shell hooks for ${eventsLine}`);
  }
  const rewrote = writePlugin(ctx, dir, wantedPlugin(ctx));
  const settings = pluginSettings(ctx.dryRun ? edit.text : (readText(path) ?? ""));
  // A running Hermes keeps the plugin it loaded; disabling and enabling it again loads the new copy.
  const load = settings?.enabled ? (rewrote ? [DISABLE, ENABLE] : []) : [ENABLE];
  runHermes(ctx, home, [...(settings?.allowed ? [] : [ALLOW]), ...load], "for a message to wake an idle chat,");
  const consent = consentFor(home, edit.text, w.commands);
  if (consent.missing.length > 0) ctx.log.push(`hermes: ${consentInstruction(consent.missing.length)}`);
  const api = describeWake(wakeConfig());
  if (api) ctx.log.push(`hermes: ${api}`);
}

function uninstall(ctx: InstallContext): void {
  const home = hermesHome(ctx);
  removePlugin(ctx, home);
  const path = configFile(home);
  const before = readText(path);
  if (before === undefined) return;
  const gone = removeManaged(before);
  if (gone.text === before) {
    if (gone.problem) throw new Error(`${path}: ${gone.problem}; left untouched`);
    return;
  }
  if (ctx.dryRun) {
    ctx.log.push(`hermes (dry run): would remove agentsocks entries from ${path}`);
    return;
  }
  guard(path, before, gone.text);
  ctx.backup(path);
  writeAtomic(path, gone.text);
  ctx.log.push(`hermes: removed agentsocks entries from ${path}`);
  for (const kept of gone.rescued) ctx.log.push(`hermes: kept ${kept} in ${path}`);
  if (gone.problem) ctx.log.push(`hermes: ${gone.problem}`);
}

function status(ctx: InstallContext): AgentStatus {
  let home: string;
  try {
    home = hermesHome(ctx);
  } catch (err) {
    return { state: "not wired", detail: [(err as Error).message] };
  }
  const path = configFile(home);
  if (!existsSync(home)) return { state: "not installed", detail: [] };
  const text = readText(path);
  if (text === undefined) return { state: "not wired", detail: [] };
  const w = wiring(ctx);
  const found = inspectManaged(text);
  const detail: string[] = [];
  if (found.problem) detail.push(`${path}: ${found.problem}`);
  for (const kept of found.rescued) detail.push(`${path}: ${kept}; run \`agentsocks install --hermes\` to move it out of the block`);
  const here = (s: string): boolean => norm(s).includes(w.node) && norm(s).includes(w.cli);
  let present = 0;
  let current = 0;
  const total = 1 + w.commands.length;
  if (found.server !== undefined) {
    present++;
    if (here(found.server)) current++;
    else detail.push("mcp_servers.agentsocks points at another agentsocks install; run `agentsocks install --hermes` to update it");
  } else if (found.foreignServer) detail.push("an mcp_servers.agentsocks entry that agentsocks did not write is in place, so the MCP server is not wired");
  else detail.push("mcp_servers.agentsocks is missing");
  for (const { event } of w.commands) {
    const own = found.hooks.filter((h) => norm(h).includes(`hook hermes ${event}`));
    if (own.length === 0) detail.push(`shell hook ${event} is missing`);
    else {
      present++;
      if (own.some(here)) current++;
      else detail.push(`shell hook ${event} points at another agentsocks install; run \`agentsocks install --hermes\` to update it`);
    }
  }
  if (present === 0) return { state: "not wired", detail: found.problem ? detail : [] };
  const plugin = pluginReport(ctx, home, text);
  const api = describeWake(wakeConfig());
  const wake = api ? [...plugin.lines, api] : plugin.lines;
  if (current < total || found.rescued.length > 0 || !plugin.current) return { state: "partly wired", detail: [...detail, ...wake] };
  const consent = consentFor(home, text, w.commands);
  if (consent.missing.length > 0) return { state: "partly wired", detail: [consentInstruction(consent.missing.length), ...(consent.problem ? [consent.problem] : []), ...wake] };
  return { state: "wired", detail: wake };
}

export const hermesInstaller: AgentInstaller = {
  detect: (ctx) => {
    try {
      return existsSync(hermesHome(ctx));
    } catch {
      return false;
    }
  },
  install,
  uninstall,
  status,
};
