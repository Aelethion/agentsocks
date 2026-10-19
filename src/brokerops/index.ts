import { askOps } from "./asks.ts";
import { channelOps } from "./channels.ts";
import { gatewayOps } from "../gateway/ops.ts";
import { labelOps } from "./labels.ts";
import { messagingOps } from "./messaging.ts";
import { opencodeOps } from "./opencode.ts";
import { ompOps } from "./omp.ts";
import { statusOps } from "./status.ts";
import { taskOps } from "./tasks.ts";
import { threadOps } from "./threads.ts";
import { topOps } from "./top.ts";
import type { OpHandler, OpTable } from "./types.ts";

export function registry(...tables: OpTable[]): ReadonlyMap<string, OpHandler> {
  const ops = new Map<string, OpHandler>();
  for (const table of tables) {
    for (const [name, handler] of Object.entries(table)) {
      if (ops.has(name)) throw new Error(`broker op ${name} is registered twice`);
      ops.set(name, handler);
    }
  }
  return ops;
}

export const OPS = registry(statusOps, threadOps, messagingOps, taskOps, channelOps, askOps, labelOps, topOps, gatewayOps, opencodeOps, ompOps);
