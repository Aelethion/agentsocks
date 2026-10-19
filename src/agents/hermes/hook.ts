import { WAKE_PREFIX } from "../../codexframe.ts";
import { stampSession } from "../../stamp.ts";
import { isRecord } from "../files.ts";
import { agentHookRequest, type AgentHookFields } from "../request.ts";
import { threadIdFor, type HookRun } from "../types.ts";
import { dropNotice, stashNotice } from "./pending.ts";

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const OUR_TOOL = /^mcp_{1,2}agentsocks_{1,2}(.+)$/;
const WAKE_LINE = new RegExp(`^${WAKE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (?:\\d+ new messages|new message) from .{1,80}?\\. Read (?:it|them) (?:with read_inbox\\.|by running: agentsocks inbox)$`);

async function isOurTool(name: string): Promise<boolean> {
  const tool = OUR_TOOL.exec(name)?.[1];
  if (!tool) return false;
  const { toolsFor } = await import("../../tools/index.ts");
  return toolsFor("codex").some((t) => t.name === tool);
}

export async function hermesHook({ event, input, call }: HookRun): Promise<string | undefined> {
  const thread = threadIdFor("hermes", input.session_id);
  if (!thread) return undefined;
  const extra = isRecord(input.extra) ? input.extra : {};
  const fields = (kind: AgentHookFields["event"], more: Partial<AgentHookFields> = {}): AgentHookFields => ({ session: input.session_id, cwd: input.cwd, event: kind, ...more });
  const ask = async (kind: AgentHookFields["event"], more?: Partial<AgentHookFields>) => call(agentHookRequest("hermes", fields(kind, more))!);

  switch (event) {
    case "pre_llm_call": {
      const message = text(extra.user_message);
      const woke = message !== undefined && WAKE_LINE.test(message.trim());
      const prompt = message?.startsWith(WAKE_PREFIX) && !woke ? message.slice(WAKE_PREFIX.length).trimStart() : message;
      const parts: string[] = [];
      if (extra.is_first_turn === true) {
        const start = await ask("SessionStart");
        if (start.context) parts.push(start.context);
      }
      const turn = await ask("UserPromptSubmit", { prompt });
      const held = dropNotice(thread);
      if (!woke) {
        if (held) parts.push(held);
        if (turn.context) parts.push(turn.context);
      }
      return parts.length > 0 ? JSON.stringify({ context: [...new Set(parts)].join("\n") }) : undefined;
    }
    case "pre_tool_call": {
      const tool = text(input.tool_name);
      if (!tool || !(await isOurTool(tool))) return undefined;
      const args = isRecord(input.tool_input) ? input.tool_input : {};
      return JSON.stringify({ action: "modify", args: { ...args, _session: stampSession("hermes", input.session_id as string) } });
    }
    case "pre_verify": {
      const stop = await ask("Stop");
      return stop.block ? JSON.stringify({ action: "continue", message: stop.block }) : undefined;
    }
    case "on_session_end": {
      const stop = await ask("Stop");
      if (stop.block) {
        try {
          stashNotice(thread, stop.block);
        } finally {
          await ask("Stop");
        }
      }
      return undefined;
    }
    case "on_session_finalize":
      await ask("SessionEnd");
      dropNotice(thread);
      return undefined;
    default:
      return undefined;
  }
}
