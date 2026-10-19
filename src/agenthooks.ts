import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { brokerCall } from "./client.ts";
import { killSwitchOn, stateDir } from "./paths.ts";
import type { HookResult } from "./broker.ts";
import type { AgentSpec, BrokerHookCall } from "./agents/types.ts";

export const callBrokerHook: BrokerHookCall = (req) => brokerCall<HookResult>("hook", req as unknown as Record<string, unknown>, { timeoutMs: 4000, startWaitMs: 1500 });

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseInput(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export async function runAgentHook(spec: AgentSpec, event: string, call: BrokerHookCall = callBrokerHook, read: () => Promise<string> = readStdin): Promise<string | undefined> {
  try {
    if (killSwitchOn()) return undefined;
    return await spec.hook({ event, input: parseInput(await read()), call });
  } catch (err) {
    try {
      appendFileSync(join(stateDir(), "daemon.log"), `${new Date().toISOString()} ${spec.id} hook error: ${(err as Error).message}\n`);
    } catch {}
    return undefined;
  }
}
