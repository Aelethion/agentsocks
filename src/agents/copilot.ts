import { copilotHook } from "./copilot/hook.ts";
import { copilotInstaller } from "./copilot/install.ts";
import type { AgentSpec } from "./types.ts";

export const copilotAgent: AgentSpec = { id: "copilot", live: "untested", hook: copilotHook, installer: copilotInstaller() };
