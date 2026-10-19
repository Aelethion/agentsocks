import { pathToFileURL } from "node:url";
import { z as zod } from "zod";

type Handler = (event: Record<string, unknown>, ctx: Ctx) => unknown;

export interface Identity {
  kind: "main" | "sub";
  id: string;
  name: string;
  depth: number;
  parentId?: string;
}

export const MAIN: Identity = { kind: "main", id: "Main", name: "main", depth: 0 };
export const EXPLORE: Identity = { kind: "sub", id: "0-Explore", name: "explore", depth: 1, parentId: "Main" };
export const ADVISOR: Identity = { kind: "sub", id: "advisor", name: "advisor", depth: 0, parentId: "Main" };

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  loadMode?: string;
  approval?: string;
  execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: Ctx): Promise<{ content: { type: string; text: string }[] }>;
}

export interface Ctx {
  agent?: Identity;
  cwd: string;
  mode: string;
  hasUI: boolean;
  sessionManager: { getSessionId(): string; getSessionName(): string | undefined };
  isIdle(): boolean;
  setInterval(callback: () => unknown, ms?: number): ReturnType<typeof setInterval>;
  setTimeout(callback: () => unknown, ms?: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setInterval>): void;
}

export interface Sent {
  message: { customType: string; content: string; display: boolean };
  options: { triggerTurn?: boolean; deliverAs?: string };
  idle: boolean;
}

const SCHEMA_METHODS = new Set(["parse", "safeParse", "min", "max", "int", "positive", "nonnegative", "regex", "url", "optional", "nullable", "default", "describe", "refine", "superRefine", "trim", "transform", "catch", "strict", "passthrough", "strip", "partial"]);
const ARITY: Record<string, number> = { min: 1, max: 1, int: 0, positive: 0, nonnegative: 0, regex: 2, url: 0, default: 1, describe: 1 };

interface Schema {
  _def: unknown;
  [key: string]: unknown;
}

export function ompTypeZod() {
  const raw = new WeakMap<object, Schema>();
  const wrap = (schema: Schema): Schema => {
    const proxy: Schema = new Proxy(schema, {
      get(target, prop) {
        if (typeof prop === "symbol") return Reflect.get(target, prop);
        const value = target[prop];
        if (typeof value !== "function") return value;
        if (!SCHEMA_METHODS.has(prop)) throw new Error(`omptype's zod builder has no .${prop}()`);
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args.slice(0, ARITY[prop] ?? args.length));
          return out && typeof out === "object" && "_def" in out ? wrap(out as Schema) : out;
        };
      },
    });
    raw.set(proxy, schema);
    return proxy;
  };
  const unwrap = (value: unknown): unknown => (value && typeof value === "object" ? (raw.get(value) ?? value) : value);
  const shape = (value: Record<string, unknown>): Record<string, never> => Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrap(v)])) as never;
  return {
    string: () => wrap(zod.string() as never),
    number: () => wrap(zod.number() as never),
    boolean: () => wrap(zod.boolean() as never),
    enum: (values: [string, ...string[]]) => wrap(zod.enum(values) as never),
    array: (element: unknown) => wrap(zod.array(unwrap(element) as never) as never),
    object: (value: Record<string, unknown>) => wrap(zod.object(shape(value) as never) as never),
    literal: (value: never) => wrap(zod.literal(value) as never),
    unknown: () => wrap(zod.unknown() as never),
  };
}

export interface LoadOptions {
  file: string;
  sessionId: string;
  cwd?: string;
  identity?: Identity | null;
  sessionName?: string;
}

export class FakeOmp {
  readonly handlers = new Map<string, Handler[]>();
  readonly tools = new Map<string, ToolDefinition>();
  readonly sent: Sent[] = [];
  readonly errors: string[] = [];
  readonly forbidden: string[] = [];
  idle = true;
  defersTurns = false;
  planMode = false;
  escSuppressed = false;
  onSend: ((sent: Sent) => void) | undefined;
  sessionName: string | undefined;
  sessionId: string;
  cwd: string;
  identity: Identity | null;
  private timers = new Set<ReturnType<typeof setInterval>>();

  private constructor(opts: LoadOptions) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd ?? "/work/api";
    this.identity = opts.identity === undefined ? MAIN : opts.identity;
    this.sessionName = opts.sessionName;
  }

  static async load(opts: LoadOptions): Promise<FakeOmp> {
    const host = new FakeOmp(opts);
    const mod = (await import(`${pathToFileURL(opts.file).href}?host=${Math.random().toString(36).slice(2)}`)) as { default: unknown } & Record<string, unknown>;
    const exported = Object.keys(mod);
    if (exported.length !== 1 || typeof mod.default !== "function") throw new Error(`an OMP extension module must export one default factory, this exports ${exported.join(", ")}`);
    await (mod.default as (pi: unknown) => unknown)(host.pi());
    return host;
  }

  private pi() {
    const zodApi = ompTypeZod();
    return {
      zod: zodApi,
      getSessionName: () => this.sessionName,
      on: (event: string, handler: Handler) => {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      },
      registerTool: (tool: ToolDefinition) => {
        this.tools.set(tool.name, tool);
      },
      sendMessage: (message: Sent["message"], options: Sent["options"] = {}) => {
        const sent = { message, options, idle: this.idle };
        this.sent.push(sent);
        const asideStarts = options.deliverAs === "aside" && !this.planMode && !this.escSuppressed;
        const triggerStarts = options.triggerTurn === true && options.deliverAs === undefined;
        if ((asideStarts || triggerStarts) && this.idle && !this.defersTurns) {
          this.idle = false;
          setTimeout(() => (this.idle = true), 300).unref();
        }
        this.onSend?.(sent);
      },
      sendUserMessage: (content: unknown) => {
        this.forbidden.push(`sendUserMessage(${JSON.stringify(content)})`);
        throw new Error("an extension must never call sendUserMessage");
      },
    };
  }

  ctx(identity: Identity | null = this.identity): Ctx {
    return {
      ...(identity && { agent: identity }),
      cwd: this.cwd,
      mode: "print",
      hasUI: false,
      sessionManager: { getSessionId: () => this.sessionId, getSessionName: () => this.sessionName },
      isIdle: () => this.idle,
      setInterval: (callback, ms) => {
        const timer = setInterval(() => this.contained(callback), ms);
        timer.unref();
        this.timers.add(timer);
        return timer;
      },
      setTimeout: (callback, ms) => {
        const timer = setTimeout(() => this.contained(callback), ms);
        timer.unref();
        return timer;
      },
      clearTimer: (timer) => {
        this.timers.delete(timer);
        clearInterval(timer);
        clearTimeout(timer);
      },
    };
  }

  private contained(callback: () => unknown): void {
    try {
      const result = callback();
      if (result instanceof Promise) result.catch((err: unknown) => this.errors.push(`timer: ${String(err)}`));
    } catch (err) {
      this.errors.push(`timer: ${String(err)}`);
    }
  }

  async emit(type: string, event: Record<string, unknown> = {}, identity?: Identity | null): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(type) ?? []) {
      try {
        results.push(await handler({ type, ...event }, this.ctx(identity)));
      } catch (err) {
        this.errors.push(`${type}: ${String(err)}`);
      }
    }
    return results;
  }

  async settle(event: Record<string, unknown> = {}): Promise<unknown[]> {
    this.idle = false;
    try {
      return await this.emit("agent_end", { messages: [], ...event });
    } finally {
      this.idle = true;
    }
  }

  async callTool(name: string, params: Record<string, unknown>, opts: { signal?: AbortSignal; identity?: Identity } = {}): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    const parsed = tool.parameters.safeParse(params);
    if (!parsed.success) throw new Error(`the arguments of ${name} do not fit its schema`);
    const result = await tool.execute("call-1", parsed.data as Record<string, unknown>, opts.signal, undefined, this.ctx(opts.identity));
    return result.content.map((part) => part.text).join("\n");
  }

  async switchSession(sessionId: string, reason: "new" | "resume" | "fork" = "new"): Promise<void> {
    this.sessionId = sessionId;
    await this.emit("session_switch", { reason, previousSessionFile: undefined });
  }

  async shutdown(): Promise<void> {
    await this.emit("session_shutdown");
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
  }
}
