export const SERVER_NAME = "agentsocks";

export const TOOL_MATCHER = `${SERVER_NAME}[-/][a-z_]+`;

export const TOOL_NAME = new RegExp(`^(?:${TOOL_MATCHER})$`);

export interface HookDef {
  event: string;
  timeoutSec: number;
  matcher?: string;
}

export const HOOKS: readonly HookDef[] = [
  { event: "sessionStart", timeoutSec: 10 },
  { event: "preToolUse", timeoutSec: 10, matcher: TOOL_MATCHER },
  { event: "postToolUse", timeoutSec: 10 },
  { event: "agentStop", timeoutSec: 10 },
  { event: "sessionEnd", timeoutSec: 3 },
];
