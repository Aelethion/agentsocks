import { existsSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { HookRequest } from "../broker.ts";
import { brokerCall } from "../client.ts";
import { WAKE_PREFIX } from "../codexframe.ts";
import { PLUGIN_FILE, PLUGIN_MARKER, pluginSource } from "./opencode/plugin.ts";
import { DEFAULT_POLL_MS, MAX_POLL_MS, offerWake, pollLimit, sinkId, type Wake } from "./opencode/sink.ts";
import { writeAtomic } from "./files.ts";
import { agentHookRequest } from "./request.ts";
import type { AgentInstaller, AgentSpec, AgentStatus, HookRun, InstallContext } from "./types.ts";

const BROKER_EVENTS = new Map<string, HookRequest["event"]>([
  ["SessionStart", "SessionStart"],
  ["UserPromptSubmit", "UserPromptSubmit"],
  ["PostToolUse", "PostToolUse"],
  ["Stop", "Stop"],
  ["SessionEnd", "SessionEnd"],
]);

export const NO_LISTENER = "no plugin is listening for this session";

const noticeText = (value: string | undefined): string | undefined => {
  const lines = (value ?? "").split("\n").filter((line) => line.startsWith(WAKE_PREFIX));
  return lines.length > 0 ? lines.join("\n") : undefined;
};

async function pollWakes(input: Record<string, unknown>): Promise<string | undefined> {
  const sink = sinkId(input.sink);
  if (!sink) return undefined;
  const timeoutMs = pollLimit(typeof input.timeoutMs === "number" ? input.timeoutMs : DEFAULT_POLL_MS);
  try {
    const reply = await brokerCall<{ wakes: Wake[] }>("opencode_wake_wait", { sink, timeoutMs }, { timeoutMs: Math.min(timeoutMs, MAX_POLL_MS) + 10_000, autoStart: false });
    return JSON.stringify({ wakes: reply.wakes });
  } catch {
    return undefined;
  }
}

async function hook({ event, input, call }: HookRun): Promise<string | undefined> {
  if (event === "wake") return pollWakes(input);
  const kind = BROKER_EVENTS.get(event);
  if (!kind) return undefined;
  const request = agentHookRequest("opencode", { session: input.session, event: kind, cwd: input.cwd, prompt: input.prompt, toolName: input.tool, remote: sinkId(input.remote) });
  if (!request) return undefined;
  const result = await call(request);
  if (kind === "SessionEnd") return undefined;
  if (kind === "Stop") {
    const block = noticeText(result.block);
    return block ? JSON.stringify({ block }) : undefined;
  }
  const context = noticeText(result.context);
  return context ? JSON.stringify({ context }) : undefined;
}

interface ConfigDirs {
  install: string;
  all: string[];
}

const usable = (path: string | undefined): string | undefined => (path && isAbsolute(path) ? path : undefined);

function configDirs(ctx: InstallContext, env: NodeJS.ProcessEnv): ConfigDirs {
  const global = join(usable(env.XDG_CONFIG_HOME) ?? join(ctx.home, ".config"), "opencode");
  const custom = usable(env.OPENCODE_CONFIG_DIR);
  return { install: custom ?? global, all: custom && custom !== global ? [custom, global] : [global] };
}

const pluginPath = (dir: string): string => join(dir, "plugins", PLUGIN_FILE);

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

const isOurs = (text: string | undefined): boolean => text !== undefined && text.startsWith(PLUGIN_MARKER);

function removeFile(ctx: InstallContext, file: string, why: string): void {
  if (ctx.dryRun) {
    ctx.log.push(`opencode (dry run): would remove ${file}${why}`);
    return;
  }
  ctx.backup(file);
  unlinkSync(file);
  const plugins = dirname(file);
  if (existsSync(plugins) && readdirSync(plugins).length === 0) rmdirSync(plugins);
  const config = dirname(plugins);
  if (existsSync(config) && readdirSync(config).length === 0) rmdirSync(config);
  ctx.log.push(`opencode: removed ${file}${why}`);
}

export function opencodeInstaller(env: () => NodeJS.ProcessEnv = () => process.env): AgentInstaller {
  const wanted = (ctx: InstallContext): string => {
    const [node, cli] = ctx.command();
    return pluginSource({ node: node!, cli: cli! });
  };
  const detect = (ctx: InstallContext): boolean => configDirs(ctx, env()).all.some(isDirectory) || ctx.hasBinary("opencode");
  return {
    detect,
    install(ctx) {
      const dirs = configDirs(ctx, env());
      const file = pluginPath(dirs.install);
      const text = wanted(ctx);
      const current = readText(file);
      if (current !== undefined && !isOurs(current)) throw new Error(`${file} exists and is not an agentsocks plugin; left untouched`);
      if (current === text) {
        ctx.log.push(`opencode: plugin ${file} already installed, unchanged`);
      } else if (ctx.dryRun) {
        ctx.log.push(`opencode (dry run): would ${current === undefined ? "write" : "update"} ${file}`);
      } else {
        if (current !== undefined) ctx.backup(file);
        writeAtomic(file, text);
        ctx.log.push(`opencode: ${current === undefined ? "wrote" : "updated"} plugin ${file} (OpenCode loads it the next time it starts)`);
      }
      for (const dir of dirs.all) {
        const other = pluginPath(dir);
        if (other !== file && isOurs(readText(other))) removeFile(ctx, other, " (an older copy; OpenCode loads every config directory, so two would run)");
      }
    },
    uninstall(ctx) {
      for (const dir of configDirs(ctx, env()).all) {
        const file = pluginPath(dir);
        if (isOurs(readText(file))) removeFile(ctx, file, "");
      }
    },
    status(ctx): AgentStatus {
      if (!detect(ctx)) return { state: "not installed", detail: [] };
      const dirs = configDirs(ctx, env());
      const found = dirs.all.map(pluginPath).filter((file) => isOurs(readText(file)));
      const foreign = dirs.all.map(pluginPath).filter((file) => existsSync(file) && !found.includes(file));
      if (found.length === 0) return { state: "not wired", detail: foreign.map((file) => `${file} exists and is not an agentsocks plugin`) };
      let text: string;
      try {
        text = wanted(ctx);
      } catch (err) {
        return { state: "partly wired", detail: [`cannot build the plugin: ${(err as Error).message}`] };
      }
      if (found.length > 1) return { state: "partly wired", detail: [`two agentsocks plugins would load: ${found.join(", ")}; run \`agentsocks install --opencode\``] };
      if (readText(found[0]!) !== text) return { state: "partly wired", detail: [`${found[0]} is out of date or points at another agentsocks install; run \`agentsocks install --opencode\``] };
      return { state: "wired", detail: [found[0]!] };
    },
  };
}

export const opencodeAgent: AgentSpec = {
  id: "opencode",
  live: "untested",
  hook,
  readTool: "agentsocks_read_inbox",
  wake: async ({ broker, thread, line }) => {
    const session = thread.thread_id.startsWith("opencode_") ? thread.thread_id.slice("opencode_".length) : undefined;
    const sink = sinkId(thread.remote);
    return session && sink && offerWake(broker, sink, { session, line }) ? { ok: true } : { ok: false, detail: NO_LISTENER };
  },
  installer: opencodeInstaller(),
};
