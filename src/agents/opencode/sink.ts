import type { Broker } from "../../broker.ts";
import type { Conn } from "../../brokerops/types.ts";
import { threadIdFor, type InboxAgentId } from "../types.ts";

export interface Wake {
  session: string;
  line: string;
  agent?: InboxAgentId;
}

interface Waiting {
  finish: (wakes?: Wake[]) => void;
}

export interface Sink {
  queue: Wake[];
  waiting: Waiting | undefined;
  seenAt: number;
}

export const LISTEN_WINDOW_MS = 35_000;
export const FORGET_AFTER_MS = 10 * 60_000;
export const MAX_POLL_MS = 280_000;
export const DEFAULT_POLL_MS = 25_000;
const MAX_QUEUED = 32;
const MAX_SINKS = 64;
const SINK_ID = /^[A-Za-z0-9_-]{8,64}$/;

const SINKS = new WeakMap<Broker, Map<string, Sink>>();

const sinksOf = (broker: Broker): Map<string, Sink> => {
  let sinks = SINKS.get(broker);
  if (!sinks) SINKS.set(broker, (sinks = new Map()));
  return sinks;
};

export const sinkId = (value: unknown): string | undefined => (typeof value === "string" && SINK_ID.test(value) ? value : undefined);

export const pollLimit = (ms: unknown): number => (typeof ms === "number" && Number.isFinite(ms) ? Math.max(0, Math.min(ms, MAX_POLL_MS)) : DEFAULT_POLL_MS);

export const sinkOf = (broker: Broker, id: string): Sink | undefined => sinksOf(broker).get(id);

export const listening = (sink: Sink, now: number): boolean => sink.waiting !== undefined || now - sink.seenAt <= LISTEN_WINDOW_MS;

const alive = (broker: Broker, wake: Wake): boolean => {
  const id = threadIdFor(wake.agent ?? "opencode", wake.session);
  const thread = id ? broker.store.getThread(id) : undefined;
  return thread !== undefined && thread.state !== "ended";
};

function drain(broker: Broker, sink: Sink): Wake[] {
  const wakes = sink.queue.filter((w) => alive(broker, w));
  sink.queue = [];
  return wakes;
}

function forgetIdle(sinks: Map<string, Sink>, now: number): void {
  for (const [id, sink] of sinks) {
    if (!sink.waiting && sink.queue.length === 0 && now - sink.seenAt > FORGET_AFTER_MS) sinks.delete(id);
  }
}

function evictOldest(sinks: Map<string, Sink>): void {
  let oldest: [string, Sink] | undefined;
  for (const entry of sinks) if (!entry[1].waiting && (!oldest || entry[1].seenAt < oldest[1].seenAt)) oldest = entry;
  if (oldest) sinks.delete(oldest[0]);
}

export function pollSink(broker: Broker, id: string, timeoutMs: number, conn: Conn, now: number = Date.now()): Promise<Wake[]> {
  const sinks = sinksOf(broker);
  forgetIdle(sinks, now);
  if (!sinks.has(id) && sinks.size >= MAX_SINKS) evictOldest(sinks);
  const sink = sinks.get(id) ?? { queue: [], waiting: undefined, seenAt: now };
  sinks.set(id, sink);
  sink.seenAt = now;
  sink.waiting?.finish();
  const ready = drain(broker, sink);
  const limit = pollLimit(timeoutMs);
  if (ready.length > 0 || limit === 0 || conn.isClosed()) return Promise.resolve(ready);
  return new Promise<Wake[]>((resolve) => {
    const waiting: Waiting = {
      finish: (wakes = []) => {
        clearTimeout(timer);
        if (sink.waiting === waiting) sink.waiting = undefined;
        sink.seenAt = Date.now();
        resolve(wakes);
      },
    };
    const timer = setTimeout(() => waiting.finish(drain(broker, sink)), limit);
    timer.unref();
    sink.waiting = waiting;
    conn.onClose(() => waiting.finish());
  });
}

export function offerWake(broker: Broker, id: string, wake: Wake, now: number = Date.now()): boolean {
  const sink = sinksOf(broker).get(id);
  if (!sink || !listening(sink, now)) return false;
  sink.queue = [...sink.queue.filter((w) => w.session !== wake.session), wake].slice(-MAX_QUEUED);
  sink.waiting?.finish(drain(broker, sink));
  return true;
}
