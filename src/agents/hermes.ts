import type { AgentSpec } from "./types.ts";
import { hermesHook } from "./hermes/hook.ts";
import { hermesInstaller } from "./hermes/installer.ts";
import { hermesWake } from "./hermes/wake.ts";

export const hermesAgent: AgentSpec = {
  id: "hermes",
  live: "untested",
  hook: hermesHook,
  wake: hermesWake.wake,
  canWake: hermesWake.canWake,
  installer: hermesInstaller,
};
