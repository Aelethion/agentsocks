import { DEFAULT_POLL_MS, pollSink, sinkId } from "../agents/opencode/sink.ts";
import type { OpTable } from "./types.ts";

export const ompOps: OpTable = {
  omp_wake_wait: async (broker, req, conn) => {
    const sink = sinkId(req.sink);
    if (!sink) throw new Error("omp_wake_wait needs a sink id of 8 to 64 letters, digits, - or _");
    return { result: { wakes: await pollSink(broker, sink, typeof req.timeoutMs === "number" ? req.timeoutMs : DEFAULT_POLL_MS, conn) } };
  },
};
