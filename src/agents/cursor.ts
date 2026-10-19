import type { AgentSpec } from "./types.ts";
import { cursorHook } from "./cursor/hooks.ts";
import { cursorInstaller } from "./cursor/install.ts";

export const cursorAgent: AgentSpec = { id: "cursor", live: "untested", hook: cursorHook, installer: cursorInstaller };
