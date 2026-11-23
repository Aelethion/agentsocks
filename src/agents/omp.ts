import type { HookRequest } from "../broker.ts";
import { WAKE_PREFIX } from "../codexframe.ts";
import { offerWake, sinkId } from "./opencode/sink.ts";
import { ompInstaller } from "./omp/installer.ts";
import { agentHookRequest } from "./request.ts";
import type { AgentSpec, HookRun } from "./types.ts";
import { pollWakes } from "./wakepoll.ts";

const BROKER_EVENTS = new Map<string, HookRequest["event"]>([
  ["SessionStart", "SessionStart"],
  ["UserPromptSubmit", "UserPromptSubmit"],
  ["PostToolUse", "PostToolUse"],
  ["Stop", "Stop"],
  ["SessionEnd", "SessionEnd"],
]);

export const NO_EXTENSION = "no OMP extension is listening for this session";

const noticeText = (value: string | undefined): string | undefined => {
  const lines = (value ?? "").split("\n").filter((line) => line.startsWith(WAKE_PREFIX));
  return lines.length > 0 ? lines.join("\n") : undefined;
};

async function hook({ event, input, call }: HookRun): Promise<string | undefined> {
  if (event === "wake") return pollWakes(input);
  const kind = BROKER_EVENTS.get(event);
  if (!kind) return undefined;
  const request = agentHookRequest("omp", { session: input.session, event: kind, cwd: input.cwd, prompt: input.prompt, toolName: input.tool, remote: sinkId(input.remote), name: input.name });
  if (!request) return undefined;
  const result = await call(request);
  if (kind === "SessionEnd") return undefined;
  if (kind === "Stop") {
    const block = noticeText(result.block);
    return block ? JSON.stringify({ block }) : undefined;
  }
  const context = noticeText(result.context);
  return context ? JSON.stringify({ context }) : undefined;
}

export const ompAgent: AgentSpec = {
  id: "omp",
  live: "untested",
  hook,
  readTool: "agentsocks_read_inbox",
  wake: async ({ broker, thread, line }) => {
    const session = thread.thread_id.startsWith("omp_") ? thread.thread_id.slice("omp_".length) : undefined;
    const sink = sinkId(thread.remote);
    return session && sink && offerWake(broker, sink, { session, line, agent: "omp" }) ? { ok: true } : { ok: false, detail: NO_EXTENSION };
  },
  installer: ompInstaller(),
};
