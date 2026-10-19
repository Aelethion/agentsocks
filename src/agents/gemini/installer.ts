import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJsonObject, writeJsonObject } from "../files.ts";
import type { AgentInstaller, AgentStatus, InstallContext } from "../types.ts";
import { applyWiring, blockers, geminiDir, inspect, removeWiring, settingsPath, wiringFor } from "./settings.ts";

function shaped<T>(path: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}; left untouched`);
  }
}

function detect(ctx: InstallContext): boolean {
  const dir = geminiDir(ctx.home);
  return ctx.hasBinary("gemini") || existsSync(join(dir, "settings.json")) || existsSync(join(dir, "tmp"));
}

function install(ctx: InstallContext): void {
  const file = readJsonObject(settingsPath(ctx.home));
  const changes = shaped(file.path, () => applyWiring(file.doc, wiringFor(ctx)));
  const warnings = blockers(file.doc).map((b) => `gemini: warning, ${b}`);
  if (changes.length === 0) {
    ctx.log.push(`gemini: agentsocks already wired in ${file.path}, unchanged`, ...warnings);
    return;
  }
  writeJsonObject(file, ctx, "gemini");
  ctx.log.push(
    `gemini${ctx.dryRun ? " (dry run)" : ""}: ${changes.join(", ")}. Untested live and pull-only: Gemini CLI cannot be woken, so a message shows at the next tool call or when a turn ends. Restart Gemini CLI sessions to load it.`,
    ...warnings,
  );
}

function uninstall(ctx: InstallContext): void {
  const path = settingsPath(ctx.home);
  if (!existsSync(path)) return;
  const file = readJsonObject(path);
  const changes = shaped(path, () => removeWiring(file.doc));
  if (changes.length === 0) return;
  writeJsonObject(file, ctx, "gemini");
  if (!ctx.dryRun && Object.keys(file.doc).length === 0 && !lstatSync(path).isSymbolicLink()) unlinkSync(path);
  ctx.log.push(`gemini${ctx.dryRun ? " (dry run)" : ""}: ${changes.join(", ")}`);
}

function status(ctx: InstallContext): AgentStatus {
  if (!detect(ctx)) return { state: "not installed", detail: [] };
  let doc: Record<string, unknown>;
  try {
    doc = readJsonObject(settingsPath(ctx.home)).doc;
  } catch (err) {
    return { state: "not wired", detail: [(err as Error).message] };
  }
  const found = inspect(doc, wiringFor(ctx));
  if (found.present === 0) return { state: "not wired", detail: blockers(doc) };
  const detail = [...found.missing.map((m) => `missing ${m}`), ...found.stale.map((s) => `stale ${s}, run agentsocks install --gemini`), ...blockers(doc)];
  return { state: detail.length === 0 ? "wired" : "partly wired", detail };
}

export const geminiInstaller: AgentInstaller = { detect, install, uninstall, status };
