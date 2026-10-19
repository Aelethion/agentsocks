import { runAgentTool } from "../agenttool.ts";
import { isAgentId, type InboxAgentId } from "../agents/types.ts";
import { option, readStdin } from "./args.ts";
import type { Handler } from "./types.ts";

export const tool: Handler = async (args) => {
  const session = option(args, "--session");
  const cwd = option(args, "--cwd");
  const [agent, name] = args;
  if (!agent || !isAgentId(agent) || agent === "codex" || !name || !session) throw new Error("usage: agentsocks tool <agent> <tool> --session <id> [--cwd <dir>]   (arguments as JSON on stdin)");
  const raw = await readStdin();
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    console.log(JSON.stringify({ text: "the arguments are not valid JSON", isError: true }));
    return 1;
  }
  const outcome = await runAgentTool(agent as InboxAgentId, name, session, cwd, parsed).catch((err: Error) => ({ text: err.message, isError: true }));
  console.log(JSON.stringify(outcome));
  return outcome.isError ? 1 : 0;
};
