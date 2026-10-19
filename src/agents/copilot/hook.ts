import type { HookRequest, HookResult } from "../../broker.ts";
import { stampSession } from "../../stamp.ts";
import { agentHookRequest } from "../request.ts";
import { threadIdFor, type HookRun } from "../types.ts";
import { TOOL_NAME } from "./events.ts";

const SESSION_FIELD = "_session";

interface Mapping {
  broker: HookRequest["event"];
  render(result: HookResult): object | undefined;
}

const additionalContext = (r: HookResult): object | undefined => (r.context ? { additionalContext: r.context } : undefined);

const MAPPINGS = new Map<string, Mapping>([
  ["sessionStart", { broker: "SessionStart", render: additionalContext }],
  ["postToolUse", { broker: "PostToolUse", render: additionalContext }],
  ["agentStop", { broker: "Stop", render: (r) => (r.block ? { decision: "block", reason: r.block } : undefined) }],
  ["sessionEnd", { broker: "SessionEnd", render: () => undefined }],
]);

function argumentsOf(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null || raw === "") return {};
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stamp(input: Record<string, unknown>): string | undefined {
  const { sessionId, toolName } = input;
  if (typeof sessionId !== "string" || !threadIdFor("copilot", sessionId)) return undefined;
  if (typeof toolName !== "string" || !TOOL_NAME.test(toolName)) return undefined;
  const args = argumentsOf(input.toolArgs);
  if (!args) return undefined;
  return JSON.stringify({ modifiedArgs: { ...args, [SESSION_FIELD]: stampSession("copilot", sessionId) } });
}

export async function copilotHook({ event, input, call }: HookRun): Promise<string | undefined> {
  if (event === "preToolUse") return stamp(input);
  const mapping = MAPPINGS.get(event);
  if (!mapping) return undefined;
  const req = agentHookRequest("copilot", { session: input.sessionId, event: mapping.broker, cwd: input.cwd, source: input.source, toolName: input.toolName });
  if (!req) return undefined;
  const out = mapping.render(await call(req));
  return out && JSON.stringify(out);
}
