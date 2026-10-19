import type { Broker } from "../broker.ts";
import { ClaudeList, systemDeps, type Deps, type Listing } from "../claudelist.ts";
import { namespacedSocketPath } from "../paths.ts";
import { codexState } from "../views.ts";
import type { SweepStage } from "./types.ts";

const LISTED_WINDOW_MS = 24 * 3_600_000;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function listingsOf(broker: Broker, now: number): Listing[] {
  return broker.store.listThreads().flatMap((t) => {
    const socketPath = namespacedSocketPath(t.thread_id);
    if (!socketPath || !t.cwd || t.subagent === 1 || !THREAD_ID.test(t.thread_id) || now - t.last_seen >= LISTED_WINDOW_MS) return [];
    if (broker.describe(t).socketPath !== socketPath) return [];
    const state = codexState(t, now);
    return [{ threadId: t.thread_id, name: t.name, cwd: t.cwd, socketPath, ...((state === "busy" || state === "idle") && { status: state }) }];
  });
}

export function claudeListStage(overrides: Partial<Deps> = {}): SweepStage {
  const lists = new WeakMap<Broker, ClaudeList>();
  return {
    name: "claude listagents",
    run: (broker, now) => {
      let list = lists.get(broker);
      if (!list) {
        const own = new ClaudeList({ ...systemDeps(), ...overrides });
        list = own;
        lists.set(broker, own);
        // a SweepStage has no stop hook, and records must go before the sockets they name
        const stop = broker.stop.bind(broker);
        broker.stop = async () => {
          try {
            own.close();
          } finally {
            await stop();
          }
        };
      }
      list.run(() => listingsOf(broker, now), now);
    },
  };
}

export const claudeListStages: readonly SweepStage[] = [claudeListStage()];
