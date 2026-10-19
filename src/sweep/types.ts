import type { Broker } from "../broker.ts";

export interface SweepStage {
  name: string;
  run: (broker: Broker, now: number) => void | Promise<void>;
}
