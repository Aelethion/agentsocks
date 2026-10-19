import type { SweepStage } from "./types.ts";

export const askStages: readonly SweepStage[] = [{ name: "asks", run: (broker, now) => broker.asks.maintain(now) }];
