import type { HookRequest, HookResult } from "../../broker.ts";
import { stampSession } from "../../stamp.ts";
import { isRecord } from "../files.ts";
import { agentHookRequest } from "../request.ts";
import { toolsFor } from "../../tools/index.ts";
import { threadIdFor, type HookRun } from "../types.ts";

export const SESSION_FIELD = "_session";
export const LOOP_LIMIT = 5;
// The docs never say whether "allow" from a hook skips Cursor's own approval for an MCP tool; "ask" is schema-valid and, not being enforced, defers to it.
export const STAMP_PERMISSION = "ask";
const SERVER_NAME = "agentsocks";
const MCP_PREFIX = "MCP:";

export const TOOL_NAMES: readonly string[] = toolsFor("codex").map((t) => t.name);

export type CursorEvent = "sessionStart" | "preToolUse" | "postToolUse" | "stop" | "sessionEnd";

export interface CursorHookSpec {
  timeout: number;
  matcher?: string;
  loop_limit?: number;
}

export const CURSOR_HOOKS: Record<CursorEvent, CursorHookSpec> = {
  sessionStart: { timeout: 10 },
  preToolUse: { timeout: 10, matcher: `^${MCP_PREFIX}(${TOOL_NAMES.join("|")})$` },
  postToolUse: { timeout: 10 },
  stop: { timeout: 10, loop_limit: LOOP_LIMIT },
  sessionEnd: { timeout: 5 },
};

type Input = Record<string, unknown>;
type Handler = (run: HookRun) => Promise<string | undefined>;

const sessionOf = (input: Input): unknown => input.conversation_id ?? input.session_id;

function validSession(input: Input): string | undefined {
  const session = sessionOf(input);
  return typeof session === "string" && threadIdFor("cursor", session) ? session : undefined;
}

function workspaceOf(input: Input): unknown {
  const first = Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined;
  return typeof first === "string" && first ? first : input.cwd;
}

const additionalContext = ({ context }: HookResult): string | undefined => (context ? JSON.stringify({ additional_context: context }) : undefined);

const forward = (event: HookRequest["event"], reply: (result: HookResult) => string | undefined): Handler => async ({ input, call }) => {
  const req = agentHookRequest("cursor", { session: sessionOf(input), event, cwd: workspaceOf(input), toolName: input.tool_name });
  return req ? reply(await call(req)) : undefined;
};

const followUp = forward("Stop", ({ block }) => (block ? JSON.stringify({ followup_message: block }) : undefined));

// An aborted or errored turn is not continued behind the user's back, and past Cursor's loop limit the follow-up would be dropped after the broker counted the messages as announced.
function turnCanContinue(input: Input): boolean {
  const spent = typeof input.loop_count === "number" && input.loop_count >= LOOP_LIMIT;
  return input.status !== "aborted" && input.status !== "error" && !spent;
}

const unprefixed = (name: string): string => (name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name);

function toolArguments(raw: unknown): Input | undefined {
  if (isRecord(raw)) return raw;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") return undefined;
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// updated_input replaces the whole input, so it is only written when the original arguments were read in full (a tool without arguments may arrive as nothing at all).
async function stampCall({ input }: HookRun): Promise<string | undefined> {
  const session = validSession(input);
  const args = toolArguments(input.tool_input);
  const name = input.tool_name;
  const ours = typeof name === "string" && TOOL_NAMES.includes(unprefixed(name));
  const otherServer = input.mcp_server_name !== undefined && input.mcp_server_name !== SERVER_NAME;
  if (!session || !args || !ours || otherServer) return undefined;
  return JSON.stringify({ permission: STAMP_PERMISSION, updated_input: { ...args, [SESSION_FIELD]: stampSession("cursor", session) } });
}

const HANDLERS: Record<CursorEvent, Handler> = {
  sessionStart: forward("SessionStart", additionalContext),
  preToolUse: stampCall,
  postToolUse: forward("PostToolUse", additionalContext),
  stop: async (run) => (turnCanContinue(run.input) ? followUp(run) : undefined),
  sessionEnd: forward("SessionEnd", () => undefined),
};

export async function cursorHook(run: HookRun): Promise<string | undefined> {
  return Object.hasOwn(HANDLERS, run.event) ? HANDLERS[run.event as CursorEvent](run) : undefined;
}
