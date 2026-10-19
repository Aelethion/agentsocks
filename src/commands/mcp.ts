import { runMcp } from "../mcp.ts";
import { isAgentId, type InboxAgentId } from "../agents/types.ts";
import { option } from "./args.ts";
import { STAY_RUNNING, type Handler } from "./types.ts";

export const mcp: Handler = async (args) => {
  const agent = option(args, "--agent");
  if (agent !== undefined && (!isAgentId(agent) || agent === "codex")) throw new Error(`usage: agentsocks mcp --host claude|codex, or --agent opencode|hermes|cursor|copilot|gemini|omp`);
  if (agent) await runMcp("codex", agent as InboxAgentId);
  else await runMcp(option(args, "--host") === "codex" ? "codex" : "claude");
  return STAY_RUNNING;
};
