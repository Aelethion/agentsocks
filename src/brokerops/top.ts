import { topSnapshot } from "../top.ts";
import type { OpTable } from "./types.ts";

export const topOps: OpTable = {
  top: async (broker) => ({ result: topSnapshot(broker) }),
};
