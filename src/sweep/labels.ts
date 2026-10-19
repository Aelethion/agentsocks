import type { SweepStage } from "./types.ts";

export const labelStages: readonly SweepStage[] = [{ name: "labels", run: (broker, now) => void broker.labels.collect(now) }];
