import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { brokerCall } from "./client.ts";
import { killSwitchOn, stateDir } from "./paths.ts";
import { redactSecrets } from "./redact.ts";
import type { HookRequest, HookResult } from "./broker.ts";

const EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]);

export function codexHookOutput(event: string, result: HookResult): string | undefined {
  if (event === "Stop") return result.block ? JSON.stringify({ decision: "block", reason: result.block }) : undefined;
  if (event === "SessionEnd" || !result.context) return undefined;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: result.context } });
}

export function hookRequest(input: Record<string, unknown>): HookRequest | undefined {
  const event = input.hook_event_name;
  const threadId = input.session_id;
  if (typeof event !== "string" || !EVENTS.has(event) || typeof threadId !== "string") return undefined;
  const remote = process.env.AGENTSOCKS_CODEX_REMOTE;
  return {
    threadId,
    event: event as HookRequest["event"],
    ...(typeof input.cwd === "string" && { cwd: input.cwd }),
    ...(typeof input.permission_mode === "string" && { permissionMode: input.permission_mode }),
    ...(typeof input.source === "string" && { source: input.source }),
    ...(typeof input.prompt === "string" && { prompt: redactSecrets(input.prompt).slice(0, 500) }),
    ...(typeof input.tool_name === "string" && { toolName: input.tool_name.slice(0, 64) }),
    ...(remote && { remote }),
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runCodexHook(): Promise<void> {
  try {
    if (killSwitchOn()) return;
    const req = hookRequest(JSON.parse(await readStdin()));
    if (!req) return;
    const result = await brokerCall<HookResult>("hook", req as unknown as Record<string, unknown>, { timeoutMs: 4000, startWaitMs: 1500 });
    const out = codexHookOutput(req.event, result);
    if (out) process.stdout.write(`${out}\n`);
  } catch (err) {
    try {
      appendFileSync(join(stateDir(), "daemon.log"), `${new Date().toISOString()} hook error: ${(err as Error).message}\n`);
    } catch {}
  }
}
