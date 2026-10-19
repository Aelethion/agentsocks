import { runCodexHook } from "../hooks.ts";
import { runAgentHook } from "../agenthooks.ts";
import { agentSpec } from "../agents/index.ts";
import { hookEnvironment } from "../agents/env.ts";
import { AGENT_IDS } from "../agents/types.ts";
import type { Handler } from "./types.ts";

export const hook: Handler = async (args) => {
  const [agent, event = ""] = args;
  if (agent === "codex") {
    await runCodexHook();
    return 0;
  }
  const spec = agentSpec(agent);
  if (!spec) throw new Error(`usage: agentsocks hook ${AGENT_IDS.join("|")} [event]`);
  const kept = hookEnvironment(process.env);
  for (const name of Object.keys(process.env)) if (!(name in kept)) delete process.env[name];
  const out = await runAgentHook(spec, event);
  if (out) process.stdout.write(`${out}\n`);
  return 0;
};
