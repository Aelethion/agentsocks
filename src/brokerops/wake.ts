import { DEFAULT_POLL_MS, pollSink, sinkId } from "../agents/opencode/sink.ts";
import type { OpTable } from "./types.ts";

// The long poll every sink-based integration but OpenCode uses (OMP's extension, Hermes's plugin).
const wakeWait: OpTable[string] = async (broker, req, conn) => {
  const sink = sinkId(req.sink);
  if (!sink) throw new Error("wake_wait needs a sink id of 8 to 64 letters, digits, - or _");
  return { result: { wakes: await pollSink(broker, sink, typeof req.timeoutMs === "number" ? req.timeoutMs : DEFAULT_POLL_MS, conn) } };
};

// omp_wake_wait is the name the released OMP extension still sends; clients now send wake_wait.
export const wakeOps: OpTable = { wake_wait: wakeWait, omp_wake_wait: wakeWait };
