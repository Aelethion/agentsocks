import { askStages } from "./asks.ts";
import { channelStages } from "./channels.ts";
import { claudeListStages } from "./claudelist.ts";
import { gatewayStages } from "../gateway/stages.ts";
import { coreStages } from "./core.ts";
import { labelStages } from "./labels.ts";
import type { SweepStage } from "./types.ts";

export type { SweepStage } from "./types.ts";

export function stages(...lists: (readonly SweepStage[])[]): readonly SweepStage[] {
  const all = lists.flat();
  const names = new Set<string>();
  for (const { name } of all) {
    if (names.has(name)) throw new Error(`sweep stage ${name} is registered twice`);
    names.add(name);
  }
  return all;
}

export const SWEEP_STAGES = stages(coreStages, channelStages, askStages, labelStages, gatewayStages, claudeListStages);
