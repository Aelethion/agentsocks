import type { HookResult } from "../../broker.ts";
import { stampSession } from "../../stamp.ts";
import { isRecord } from "../files.ts";
import { agentHookRequest } from "../request.ts";
import { threadIdFor, type HookRun } from "../types.ts";
import { SERVER, TOOL_PREFIX, type GeminiEvent } from "./settings.ts";

const SESSION_FIELD = "_session";

type Relayed = Exclude<GeminiEvent, "BeforeTool">;

const additionalContext = (hookEventName: Relayed) => (r: HookResult) => (r.context ? { hookSpecificOutput: { hookEventName, additionalContext: r.context } } : undefined);

const RELAYED: Record<Relayed, { broker: "SessionStart" | "PostToolUse" | "Stop" | "SessionEnd"; render: (r: HookResult) => object | undefined }> = {
  SessionStart: { broker: "SessionStart", render: additionalContext("SessionStart") },
  AfterTool: { broker: "PostToolUse", render: additionalContext("AfterTool") },
  AfterAgent: { broker: "Stop", render: (r) => (r.block ? { decision: "deny", reason: r.block } : undefined) },
  SessionEnd: { broker: "SessionEnd", render: () => undefined },
};

const isRelayed = (event: string): event is Relayed => Object.hasOwn(RELAYED, event);

function stamp(input: Record<string, unknown>): object | undefined {
  const { tool_name: tool, tool_input: toolInput, mcp_context: context, session_id: session } = input;
  if (typeof tool !== "string" || !tool.startsWith(TOOL_PREFIX)) return undefined;
  if (isRecord(context) && context.server_name !== SERVER) return undefined;
  if (!isRecord(toolInput) || !threadIdFor("gemini", session)) return undefined;
  return { hookSpecificOutput: { hookEventName: "BeforeTool", tool_input: { ...toolInput, [SESSION_FIELD]: stampSession("gemini", session as string) } } };
}

async function relay(event: Relayed, { input, call }: HookRun): Promise<object | undefined> {
  const { broker, render } = RELAYED[event];
  const req = agentHookRequest("gemini", { session: input.session_id, event: broker, cwd: input.cwd, source: input.source, toolName: input.tool_name });
  return req ? render(await call(req)) : undefined;
}

export async function geminiHook(run: HookRun): Promise<string | undefined> {
  const out = run.event === "BeforeTool" ? stamp(run.input) : isRelayed(run.event) ? await relay(run.event, run) : undefined;
  return out && JSON.stringify(out);
}
