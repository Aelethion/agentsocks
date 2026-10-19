import type { SweepStage } from "./types.ts";

export const channelStages: readonly SweepStage[] = [{ name: "channels", run: (broker, now) => broker.channels.maintain(now) }];
