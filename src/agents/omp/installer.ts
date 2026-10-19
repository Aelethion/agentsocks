import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { linkTarget, writeAtomic } from "../files.ts";
import type { AgentInstaller, AgentStatus, InstallContext } from "../types.ts";
import { EXTENSION_FILE, EXTENSION_MARKER, extensionSource } from "./extension.ts";

export const TESTED_OMP = "18.10.3";
const TESTED_MAJOR = TESTED_OMP.split(".")[0];
const PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FOREIGN: readonly { id: string; config: string }[] = [
  { id: "claude", config: "Claude Code's config (~/.claude.json)" },
  { id: "codex", config: "Codex's config (~/.codex/config.toml)" },
];

interface Layout {
  root: string;
  install: string;
}

const usable = (path: string | undefined): string | undefined => (path && isAbsolute(path) ? path : undefined);

function profileOf(env: NodeJS.ProcessEnv): string | undefined {
  const name = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim();
  if (!name || name === "default") return undefined;
  return PROFILE.test(name) && !name.endsWith(".") ? name : undefined;
}

function layout(ctx: InstallContext, env: NodeJS.ProcessEnv): Layout {
  const root = join(ctx.home, env.PI_CONFIG_DIR || ".omp");
  const profile = profileOf(env);
  if (profile) return { root, install: join(root, "profiles", profile, "agent") };
  const override = usable(env.PI_CODING_AGENT_DIR);
  return { root, install: override ?? join(root, "agent") };
}

function agentDirs(ctx: InstallContext, env: NodeJS.ProcessEnv): string[] {
  const { root, install } = layout(ctx, env);
  const profiles = join(root, "profiles");
  let named: string[] = [];
  try {
    named = readdirSync(profiles).filter((name) => PROFILE.test(name)).map((name) => join(profiles, name, "agent"));
  } catch {}
  return [...new Set([install, join(root, "agent"), ...named])];
}

const extensionPath = (dir: string): string => join(dir, "extensions", EXTENSION_FILE);

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${path} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"}); left untouched`);
  }
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isOurs = (text: string | undefined): boolean => text !== undefined && text.startsWith(EXTENSION_MARKER);

function removeFile(ctx: InstallContext, file: string): void {
  if (ctx.dryRun) {
    ctx.log.push(`omp (dry run): would remove ${file}`);
    return;
  }
  const target = linkTarget(file);
  ctx.backup(file);
  unlinkSync(file);
  if (target !== file && isOurs(readText(target))) unlinkSync(target);
  const folder = dirname(file);
  try {
    if (lstatSync(folder).isDirectory() && readdirSync(folder).length === 0) rmdirSync(folder);
  } catch {}
  ctx.log.push(`omp: removed ${file}`);
}

function listed(text: string, key: string): Set<string> {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (at === -1) return new Set();
  const unquote = (item: string): string => item.trim().replace(/^(["'])(.*)\1$/, "$2");
  const rest = lines[at]!.slice(key.length + 1).replace(/\s#.*$/, "").trim();
  if (rest.startsWith("[")) return new Set(rest.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean));
  const items = new Set<string>();
  for (const line of lines.slice(at + 1)) {
    const item = /^\s*-\s+(.+?)\s*(?:\s#.*)?$/.exec(line);
    if (item) items.add(unquote(item[1]!));
    else if (line.trim() !== "" && !line.trim().startsWith("#")) break;
  }
  return items;
}

function foreignReaders(dir: string, env: NodeJS.ProcessEnv): string[] {
  let text = "";
  for (const name of ["config.yml", "config.yaml"]) {
    try {
      text = readFileSync(join(dir, name), "utf8");
      break;
    } catch {}
  }
  const enabled = listed(text, "enabledProviders");
  const disabled = listed(text, "disabledProviders");
  const everything = enabled.has("*") || enabled.has("all");
  const reads = (id: string): boolean => !disabled.has(id) && (everything || enabled.has(id) || (id === "claude" && (env.CLAUDE_CONFIG_DIR ?? "").trim() !== ""));
  return FOREIGN.filter(({ id }) => reads(id)).map(({ id, config }) => `warning: OMP also reads ${config}, where agentsocks registered a server that cannot tell which session an OMP call comes from. To stop that, list ${id} under disabledProviders in ${join(dir, "config.yml")}`);
}

export function ompVersion(): string | undefined {
  const run = spawnSync("omp", ["--version"], { encoding: "utf8", timeout: 5000 });
  return run.status === 0 ? run.stdout.trim() : undefined;
}

function versionLine(version: string | undefined): { line: string; outside: boolean } {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!found) return { line: "omp is not on PATH or did not print a version, so the version was not checked", outside: false };
  const text = found[0];
  if (text === TESTED_OMP) return { line: `OMP ${text} (the version this extension was written against)`, outside: false };
  if (found[1] === TESTED_MAJOR) return { line: `OMP ${text} (tested on ${TESTED_OMP}; extension APIs can change between minors, so check the OMP release notes for breaking extension changes if it does not load)`, outside: false };
  return { line: `OMP ${text} is outside the ${TESTED_MAJOR}.x range this was tested on; the extension may not load`, outside: true };
}

export function ompInstaller(env: () => NodeJS.ProcessEnv = () => process.env, version: () => string | undefined = ompVersion): AgentInstaller {
  const wanted = (ctx: InstallContext): string => {
    const [node, cli] = ctx.command();
    return extensionSource({ node: node!, cli: cli! });
  };
  const detect = (ctx: InstallContext): boolean => {
    const { root, install } = layout(ctx, env());
    return isDirectory(install) || isDirectory(root) || ctx.hasBinary("omp");
  };
  return {
    detect,
    install(ctx) {
      const here = layout(ctx, env());
      const file = extensionPath(here.install);
      const text = wanted(ctx);
      const current = readText(file);
      if (current !== undefined && !isOurs(current)) throw new Error(`${file} exists and is not an agentsocks extension; left untouched`);
      if (current === text) {
        ctx.log.push(`omp: extension ${file} already installed, unchanged`);
      } else if (ctx.dryRun) {
        ctx.log.push(`omp (dry run): would ${current === undefined ? "write" : "update"} ${file}`);
      } else {
        if (current !== undefined) ctx.backup(file);
        writeAtomic(file, text);
        ctx.log.push(`omp: ${current === undefined ? "wrote" : "updated"} extension ${file} (OMP loads it the next time it starts)`);
      }
      for (const warning of foreignReaders(here.install, env())) ctx.log.push(`omp: ${warning}`);
    },
    uninstall(ctx) {
      for (const dir of agentDirs(ctx, env())) {
        const file = extensionPath(dir);
        if (isOurs(readText(file))) removeFile(ctx, file);
      }
    },
    status(ctx): AgentStatus {
      if (!detect(ctx)) return { state: "not installed", detail: [] };
      const here = layout(ctx, env());
      const file = extensionPath(here.install);
      const current = readText(file);
      if (current === undefined) return { state: "not wired", detail: [] };
      if (!isOurs(current)) return { state: "not wired", detail: [`${file} exists and is not an agentsocks extension`] };
      let text: string;
      try {
        text = wanted(ctx);
      } catch (err) {
        return { state: "partly wired", detail: [`cannot build the extension: ${(err as Error).message}`] };
      }
      if (current !== text) return { state: "partly wired", detail: [`${file} is out of date or points at another agentsocks install; run \`agentsocks install --omp\``] };
      const seen = versionLine(version());
      return { state: seen.outside ? "partly wired" : "wired", detail: [file, seen.line, ...foreignReaders(here.install, env())] };
    },
  };
}
