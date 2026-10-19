import type { AgentSpec } from "./types.ts";
import { geminiHook } from "./gemini/hook.ts";
import { geminiInstaller } from "./gemini/installer.ts";

export const geminiAgent: AgentSpec = {
  id: "gemini",
  live: "untested",
  hook: geminiHook,
  installer: geminiInstaller,
};
