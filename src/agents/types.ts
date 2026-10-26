import type { Broker, HookRequest, HookResult } from "../broker.ts";
import { THREAD_ID } from "../limits.ts";
import type { ThreadRow } from "../store.ts";

export const AGENT_IDS = ["codex", "opencode", "hermes", "cursor", "copilot", "gemini", "omp"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export type InboxAgentId = Exclude<AgentId, "codex">;

export const AGENT_LABELS: Record<AgentId, string> = {
  codex: "Codex",
  opencode: "OpenCode",
  hermes: "Hermes",
  cursor: "Cursor",
  copilot: "GitHub Copilot CLI",
  gemini: "Gemini CLI",
  omp: "OMP",
};

export const kindLabel = (kind: string, agent?: string | null): string => (agent && agent !== "codex" ? agent : kind);

export const isAgentId = (v: unknown): v is AgentId => typeof v === "string" && (AGENT_IDS as readonly string[]).includes(v);

const RAW_SESSION = /^[A-Za-z0-9_-]+$/;

export function threadIdFor(agent: AgentId, raw: unknown): string | undefined {
  if (typeof raw !== "string" || !RAW_SESSION.test(raw)) return undefined;
  const id = agent === "codex" ? raw : `${agent}_${raw}`;
  return THREAD_ID.test(id) ? id : undefined;
}

export function agentOfThreadId(threadId: string): InboxAgentId | undefined {
  const cut = threadId.indexOf("_");
  const prefix = cut === -1 ? "" : threadId.slice(0, cut);
  return AGENT_IDS.find((id): id is InboxAgentId => id !== "codex" && id === prefix);
}

export function agentFieldOf(threadId: string | null | undefined): { agent?: InboxAgentId } {
  const agent = agentOfThreadId(threadId ?? "");
  return agent ? { agent } : {};
}

export type BrokerHookCall = (req: HookRequest) => Promise<HookResult>;

export interface HookRun {
  event: string;
  input: Record<string, unknown>;
  call: BrokerHookCall;
}

export type WakeOutcome = { ok: true } | { ok: false; detail: string };

export interface WakeRequest {
  broker: Broker;
  thread: ThreadRow;
  line: string;
}

export type Liveness = "verified" | "untested";

export type AgentState = "wired" | "partly wired" | "not wired" | "not installed";

export interface AgentStatus {
  state: AgentState;
  detail: string[];
}

export interface InstallContext {
  dryRun: boolean;
  home: string;
  log: string[];
  hasBinary: (name: string) => boolean;
  command: (...args: string[]) => string[];
  backup: (path: string) => void;
}

export interface AgentInstaller {
  detect(ctx: InstallContext): boolean;
  install(ctx: InstallContext): void;
  uninstall(ctx: InstallContext): void;
  status(ctx: InstallContext): AgentStatus;
}

export interface AgentSpec {
  id: InboxAgentId;
  live: Liveness;
  hook(run: HookRun): Promise<string | undefined>;
  wake?: (req: WakeRequest) => Promise<WakeOutcome>;
  canWake?: () => boolean;
  readTool?: string;
  installer: AgentInstaller;
}
