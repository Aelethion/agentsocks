import type { spawn as spawnProcess } from "node:child_process";

export interface ToolContext {
  sessionID: string;
  directory?: string;
  abort?: AbortSignal;
}

export interface PluginTool {
  name: string;
  description: string;
  args: Record<string, unknown>;
}

export interface Deps {
  spawn: typeof spawnProcess;
  randomBytes: (size: number) => { toString(encoding: "hex"): string };
  tool: (definition: { description: string; args: Record<string, unknown>; execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> }) => unknown;
  node: string;
  cli: string;
  tools: readonly PluginTool[];
}

interface SessionInfo {
  id: string;
  parentID?: string;
  directory?: string;
}

interface Part {
  type: string;
  text?: string;
  synthetic?: boolean;
}

interface Client {
  session: {
    get(options: { path: { id: string } }): Promise<{ data?: SessionInfo; error?: unknown }>;
    promptAsync(options: { path: { id: string }; body: { agent?: string; model?: { providerID: string; modelID: string }; parts: { type: "text"; text: string }[] } }): Promise<{ error?: unknown } | undefined>;
  };
}

export interface PluginInput {
  client: Client;
  directory: string;
}

interface OpenCodeEvent {
  type: string;
  properties?: { info?: SessionInfo; sessionID?: string; status?: { type?: string } };
}

export interface Hooks {
  tool: Record<string, unknown>;
  event: (input: { event: OpenCodeEvent }) => Promise<void>;
  "chat.message": (input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } }, output: { parts: Part[] }) => Promise<void>;
  "tool.execute.after": (input: { tool: string; sessionID: string; callID?: string; args?: unknown }, output: { output?: unknown }) => Promise<void>;
  dispose: () => Promise<void>;
}

export async function createPlugin(deps: Deps, input: PluginInput): Promise<Hooks> {
  const PREFIX = "📨 agentsocks:";
  const HOOK_TIMEOUT_MS = 8000;
  const TOOL_TIMEOUT_MS = 45_000;
  const POLL_MS = 25_000;
  const MIN_CYCLE_MS = 1000;
  const BUSY_STALE_MS = 15 * 60_000;
  const MAX_OUTPUT = 1_000_000;
  const KEEP_ENV = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TMP", "TEMP", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "NODE_OPTIONS", "NODE_NO_WARNINGS", "NODE_PATH", "TS_SOCKET"]);
  const childEnv = (): Record<string, string> =>
    Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && (KEEP_ENV.has(entry[0]) || entry[0].startsWith("AGENTSOCKS_") || entry[0].startsWith("LC_"))));
  const client = input.client;
  const sink = deps.randomBytes(12).toString("hex");

  const kinds = new Map<string, "root" | "child">();
  const started = new Map<string, Promise<boolean>>();
  const busy = new Map<string, number>();
  const pending = new Map<string, string>();
  const lastChoice = new Map<string, { agent?: string; model?: { providerID: string; modelID: string } }>();
  const running = new Set<{ kill(signal?: NodeJS.Signals): boolean }>();
  const stopSink = new AbortController();
  let sinkRunning = false;
  let disposed = false;

  const parse = (text: string): Record<string, unknown> => {
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const noticeLines = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const lines = value.split("\n").filter((line) => line.startsWith(PREFIX));
    return lines.length > 0 ? lines.join("\n") : undefined;
  };

  const run = (args: string[], stdin: string, timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; timedOut: boolean }> =>
    new Promise((resolve) => {
      let stdout = "";
      let timedOut = false;
      let settled = false;
      let child: ReturnType<typeof deps.spawn>;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        running.delete(child);
        resolve({ stdout, timedOut });
      };
      const stop = () => {
        try {
          child.kill("SIGKILL");
        } catch {}
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      try {
        child = deps.spawn(deps.node, [deps.cli, ...args], { stdio: ["pipe", "pipe", "ignore"], env: childEnv() });
      } catch {
        clearTimeout(timer);
        resolve({ stdout, timedOut });
        return;
      }
      running.add(child);
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk;
      });
      child.on("error", finish);
      child.on("close", finish);
      child.stdin!.on("error", () => {});
      child.stdin!.end(stdin);
    });

  const sendHook = async (event: string, session: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> =>
    parse((await run(["hook", "opencode", event], JSON.stringify({ session, remote: sink, ...extra }), HOOK_TIMEOUT_MS)).stdout);

  const hookQueues = new Map<string, Promise<unknown>>();
  const hook = (event: string, session: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const reply = (hookQueues.get(session) ?? Promise.resolve()).then(() => sendHook(event, session, extra));
    const tail = reply.catch(() => undefined);
    hookQueues.set(session, tail);
    void tail.then(() => {
      if (hookQueues.get(session) === tail) hookQueues.delete(session);
    });
    return reply;
  };

  const classify = async (id: string, known?: SessionInfo): Promise<"root" | "child" | undefined> => {
    const cached = kinds.get(id);
    if (cached) return cached;
    let info = known;
    if (!info) {
      try {
        info = (await client.session.get({ path: { id } })).data;
      } catch {
        return undefined;
      }
    }
    if (!info) return undefined;
    const kind = info.parentID ? "child" : "root";
    kinds.set(id, kind);
    return kind;
  };

  const markBusy = (id: string): void => void busy.set(id, Date.now());
  const isBusy = (id: string): boolean => Date.now() - (busy.get(id) ?? -Infinity) < BUSY_STALE_MS;

  const prompt = async (id: string, line: string): Promise<boolean> => {
    if (disposed || kinds.get(id) !== "root" || isBusy(id) || !line.startsWith(PREFIX) || line.length > 600) return false;
    markBusy(id);
    const choice = lastChoice.get(id);
    try {
      const reply = await client.session.promptAsync({
        path: { id },
        body: { ...(choice?.agent && { agent: choice.agent }), ...(choice?.model && { model: choice.model }), parts: [{ type: "text", text: line }] },
      });
      if (reply?.error) throw new Error("rejected");
      return true;
    } catch {
      busy.delete(id);
      return false;
    }
  };

  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
    });

  const listen = async (): Promise<void> => {
    let failures = 0;
    while (!disposed) {
      const began = Date.now();
      const reply = await run(["hook", "opencode", "wake"], JSON.stringify({ sink, timeoutMs: POLL_MS }), POLL_MS + 15_000, stopSink.signal);
      if (disposed) return;
      const wakes = parse(reply.stdout).wakes;
      if (!Array.isArray(wakes)) {
        failures++;
        await pause(Math.min(60_000, 1000 * 2 ** failures));
        continue;
      }
      failures = 0;
      for (const wake of wakes as { session?: unknown; line?: unknown }[]) {
        if (typeof wake?.session === "string" && typeof wake.line === "string") await prompt(wake.session, wake.line);
      }
      if (wakes.length === 0 && Date.now() - began < MIN_CYCLE_MS) await pause(MIN_CYCLE_MS - (Date.now() - began));
    }
  };

  const register = async (id: string, directory: string | undefined): Promise<boolean> => {
    const kind = await classify(id);
    if (kind === undefined) {
      started.delete(id);
      return false;
    }
    if (kind !== "root") return false;
    if (!sinkRunning && !disposed) {
      sinkRunning = true;
      void listen().catch(() => {});
    }
    await hook("SessionStart", id, { cwd: directory ?? input.directory });
    return true;
  };

  const see = (id: string, directory?: string): Promise<boolean> => {
    let result = started.get(id);
    if (!result) started.set(id, (result = register(id, directory)));
    return result;
  };

  const forget = (id: string): void => {
    for (const map of [kinds, started, pending, lastChoice] as Map<string, unknown>[]) map.delete(id);
    busy.delete(id);
  };

  const idle = async (id: string): Promise<void> => {
    if (!(await see(id)) || !busy.delete(id)) return;
    const line = noticeLines((await hook("Stop", id)).block);
    if (line) await prompt(id, line);
  };

  const call = async (name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
    const id = ctx.sessionID;
    const kind = await classify(id);
    if (kind === "child") throw new Error("agentsocks is not available inside a subagent session");
    if (kind !== "root") throw new Error("agentsocks could not tell whether this is a top-level session; call the tool again");
    await see(id, ctx.directory);
    pending.delete(id);
    const wait = name === "wait_for_message" ? (typeof args?.timeout_seconds === "number" ? args.timeout_seconds : 60) * 1000 + 20_000 : 0;
    const where = ctx.directory ? ["--cwd", ctx.directory] : [];
    const reply = await run(["tool", "opencode", name, "--session", id, ...where], JSON.stringify(args ?? {}), TOOL_TIMEOUT_MS + wait, ctx.abort);
    const last = reply.stdout.trim().split("\n").pop() ?? "";
    const outcome = parse(last);
    if (typeof outcome.text !== "string") throw new Error(reply.timedOut ? `agentsocks ${name} timed out` : ctx.abort?.aborted ? `agentsocks ${name} was cancelled` : `agentsocks ${name} failed to run`);
    if (outcome.isError) throw new Error(outcome.text);
    return outcome.text;
  };

  const tools: Record<string, unknown> = {};
  for (const entry of deps.tools) {
    tools[`agentsocks_${entry.name}`] = deps.tool({ description: entry.description, args: entry.args, execute: (args, ctx) => call(entry.name, args, ctx) });
  }

  const guard =
    <Args extends unknown[]>(handler: (...args: Args) => Promise<void>) =>
    async (...args: Args): Promise<void> => {
      try {
        await handler(...args);
      } catch {}
    };

  return {
    tool: tools,
    event: guard(async ({ event }) => {
      const props = event.properties ?? {};
      if (event.type === "session.created" && props.info?.id) {
        if ((await classify(props.info.id, props.info)) === "root") await see(props.info.id, props.info.directory);
      } else if (event.type === "session.deleted" && props.info?.id) {
        const id = props.info.id;
        if (kinds.get(id) === "root" && (await started.get(id))) await hook("SessionEnd", id);
        forget(id);
      } else if (event.type === "session.status" && typeof props.sessionID === "string") {
        const type = props.status?.type;
        if (type === "idle") await idle(props.sessionID);
        else if ((type === "busy" || type === "retry") && (await see(props.sessionID))) markBusy(props.sessionID);
      } else if (event.type === "session.idle" && typeof props.sessionID === "string") {
        await idle(props.sessionID);
      }
    }),
    "chat.message": guard(async (message, output) => {
      const id = message.sessionID;
      if (!(await see(id))) return;
      markBusy(id);
      lastChoice.set(id, { ...(message.agent && { agent: message.agent }), ...(message.model && { model: message.model }) });
      const first = output.parts.find((part) => part.type === "text" && typeof part.text === "string" && !part.synthetic);
      const notice = noticeLines((await hook("UserPromptSubmit", id, { prompt: first?.text?.slice(0, 1000) ?? "" })).context);
      if (notice) pending.set(id, notice);
    }),
    "tool.execute.after": guard(async (used, output) => {
      const id = used.sessionID;
      if (used.tool.startsWith("agentsocks_") || !(await see(id))) return;
      markBusy(id);
      const fresh = noticeLines((await hook("PostToolUse", id, { tool: used.tool })).context);
      const notice = [pending.get(id), fresh].filter(Boolean).join("\n");
      pending.delete(id);
      if (notice && typeof output.output === "string") output.output = `${output.output}\n\n${notice}`;
    }),
    dispose: async () => {
      disposed = true;
      stopSink.abort();
      const live = [...started].filter(([id]) => kinds.get(id) === "root").map(([id]) => id);
      await Promise.all(live.map((id) => hook("SessionEnd", id)));
      for (const child of running) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    },
  };
}
