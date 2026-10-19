import { z } from "zod";
import { agentIdentity } from "./peers.ts";
import { toolsFor, type Tool } from "./tools/index.ts";
import type { InboxAgentId } from "./agents/types.ts";

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

export async function runAgentTool(agent: InboxAgentId, name: string, session: string, cwd: string | undefined, rawArgs: unknown, tools: readonly Tool[] = toolsFor("codex")): Promise<ToolOutcome> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { text: `agentsocks has no tool ${name}`, isError: true };
  const parsed = z.object(tool.inputSchema).safeParse(rawArgs ?? {});
  if (!parsed.success) return { text: `${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"} ${i.message}`).join("; ")}`, isError: true };
  const result = await tool.handler(parsed.data, { host: "codex", identify: () => agentIdentity(agent, session, cwd) });
  return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
}
