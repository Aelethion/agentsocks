import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { AgentInstaller, AgentStatus, InstallContext } from "../types.ts";
import { writeAtomic } from "../files.ts";
import { configFile, hermesHome, HERMES_EVENTS, wiring } from "./config.ts";
import { consentFor, consentInstruction } from "./consent.ts";
import { describeWake, wakeConfig } from "./wake.ts";
import { addManaged, inspectManaged, removeManaged } from "./yaml.ts";

const norm = (s: string): string => s.replace(/\s+/g, " ");

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function yamlValid(text: string): boolean | undefined {
  const r = spawnSync("python3", ["-I", "-c", "import sys\ntry:\n  import yaml\nexcept ImportError:\n  sys.exit(3)\nyaml.safe_load(sys.stdin.read())"], { input: text, stdio: ["pipe", "ignore", "ignore"] });
  if (r.error || r.status === 3) return undefined;
  return r.status === 0;
}

const eventsLine = HERMES_EVENTS.join(", ");

function install(ctx: InstallContext): void {
  const home = hermesHome(ctx);
  const path = configFile(home);
  const before = readText(path) ?? "";
  const w = wiring(ctx);
  const edit = addManaged(before, w.plan);
  if (!edit.ok) throw new Error(`${path}: ${edit.reason}; left untouched`);
  if (edit.text !== before && yamlValid(before) !== false && yamlValid(edit.text) === false) throw new Error(`${path}: the edited file would not be valid YAML; left untouched`);
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
  const consent = consentFor(home, edit.text, w.commands);
  if (consent.missing.length > 0) ctx.log.push(`hermes: ${consentInstruction(consent.missing.length)}`);
  ctx.log.push(`hermes: ${describeWake(wakeConfig())}`);
}

function uninstall(ctx: InstallContext): void {
  const path = configFile(hermesHome(ctx));
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
  ctx.backup(path);
  writeAtomic(path, gone.text);
  ctx.log.push(`hermes: removed agentsocks entries from ${path}`);
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
  const wake = describeWake(wakeConfig());
  if (current < total) return { state: "partly wired", detail: [...detail, wake] };
  const consent = consentFor(home, text, w.commands);
  if (consent.missing.length > 0) return { state: "partly wired", detail: [consentInstruction(consent.missing.length), ...(consent.problem ? [consent.problem] : []), wake] };
  return { state: "wired", detail: [wake] };
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
