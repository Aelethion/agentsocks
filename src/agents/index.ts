import { AGENT_IDS, type AgentId, type AgentSpec } from "./types.ts";
import { copilotAgent } from "./copilot.ts";
import { cursorAgent } from "./cursor.ts";
import { geminiAgent } from "./gemini.ts";
import { hermesAgent } from "./hermes.ts";
import { ompAgent } from "./omp.ts";
import { opencodeAgent } from "./opencode.ts";

export * from "./types.ts";

export function agents(...lists: (readonly AgentSpec[])[]): readonly AgentSpec[] {
  const all = lists.flat();
  const ids = new Set<string>();
  const known: readonly string[] = AGENT_IDS;
  for (const spec of all) {
    const id: string = spec.id;
    if (!known.includes(id) || id === "codex") throw new Error(`agent ${id} is not an inbox agent agentsocks knows`);
    if (ids.has(id)) throw new Error(`agent ${id} is registered twice`);
    ids.add(id);
  }
  return all;
}

export const AGENTS: readonly AgentSpec[] = agents([opencodeAgent, hermesAgent, cursorAgent, copilotAgent, geminiAgent, ompAgent]);

export const agentSpec = (id: AgentId | string | null | undefined, all: readonly AgentSpec[] = AGENTS): AgentSpec | undefined => all.find((a) => a.id === id);
