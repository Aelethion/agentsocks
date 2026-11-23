import { brokerCall } from "../client.ts";
import { DEFAULT_POLL_MS, MAX_POLL_MS, pollLimit, sinkId } from "./opencode/sink.ts";

// One long poll of the broker's wake_wait op for a plugin or extension sink: the wakes as JSON, session and line
// only, or nothing when the sink id is bad or the broker cannot be reached.
export async function pollWakes(input: Record<string, unknown>): Promise<string | undefined> {
  const sink = sinkId(input.sink);
  if (!sink) return undefined;
  const timeoutMs = pollLimit(typeof input.timeoutMs === "number" ? input.timeoutMs : DEFAULT_POLL_MS);
  try {
    const reply = await brokerCall<{ wakes: { session: string; line: string }[] }>("wake_wait", { sink, timeoutMs }, { timeoutMs: Math.min(timeoutMs, MAX_POLL_MS) + 10_000, autoStart: false });
    return JSON.stringify({ wakes: reply.wakes.map(({ session, line }) => ({ session, line })) });
  } catch {
    return undefined;
  }
}
