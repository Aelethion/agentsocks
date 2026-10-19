import type { SweepStage } from "./types.ts";

export const coreStages: readonly SweepStage[] = [
  { name: "codex", run: (broker, now) => broker.sweepCodex(now) },
  { name: "claude digests", run: (broker, now) => broker.flushClaudeDigests(now) },
  { name: "shown", run: (broker, now) => broker.detectShown(now) },
  { name: "tasks", run: async (broker, now) => void (await broker.tasks.expireDue(now)) },
];
