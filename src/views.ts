import { NON_INTERRUPT_RULES, type BudgetView, type ReceiverView, type Route } from "./router.ts";
import { BUSY_STALE_MS } from "./limits.ts";
import type { RecentRow, ThreadRow } from "./store.ts";

export const BUDGET_WINDOW_MS = 10 * 60_000;
export const AWAITED_REPLY_WINDOW_MS = 30 * 60_000;

export interface Who {
  addr: string | null;
  key: string;
}

// a sender with no inbox address is told apart by name, so strangers do not pool into one budget
export const whoIs = (addr: string | null, name: string | null): Who => ({ addr, key: addr ?? `anon:${name ?? ""}` });

export interface RecentDelivery {
  msgId: string;
  from: string;
  bodyHash: string | null;
  route: Route;
  rule?: string;
  at: number;
  pending: boolean;
}

export function recentOf(rows: RecentRow[], canon: (addr: string | null) => string | null): RecentDelivery[] {
  return rows.map((r) => ({
    msgId: r.msg_id,
    from: whoIs(canon(r.from_addr), r.from_name).key,
    bodyHash: r.body_hash,
    route: r.route,
    ...(r.rule && { rule: r.rule }),
    at: r.at,
    pending: r.pending === 1,
  }));
}

export function budgetOf(recent: RecentDelivery[], senderKey: string): BudgetView {
  return {
    receiverNowLast10m: recent.filter((d) => d.route === "now" && !NON_INTERRUPT_RULES.includes(d.rule ?? "")).length,
    senderToReceiverLast10m: recent.filter((d) => d.from === senderKey).length,
  };
}

export interface DuplicateView {
  duplicateOfRecent: boolean;
  duplicateOfPending?: "digest" | "pause";
  pendingIds: string[];
}

export function duplicateOf(recent: RecentDelivery[], senderKey: string, hash: string): DuplicateView {
  const same = recent.filter((d) => d.from === senderKey && d.bodyHash === hash);
  if (same.length === 0) return { duplicateOfRecent: false, pendingIds: [] };
  if (same.some((d) => !d.pending)) return { duplicateOfRecent: true, pendingIds: [] };
  const route = same.some((d) => d.route === "pause") ? "pause" : "digest";
  return { duplicateOfRecent: true, duplicateOfPending: route, pendingIds: same.map((d) => d.msgId) };
}

export function claudeState(status: string | undefined): ReceiverView["state"] {
  if (status === "idle" || status === "shell") return "idle";
  if (status === "busy") return "busy";
  if (status === "waiting") return "waiting";
  return "unknown";
}

export function codexState(t: Pick<ThreadRow, "state" | "last_seen">, now: number): ReceiverView["state"] {
  if (t.state === "idle") return "idle";
  if (t.state === "busy") return now - t.last_seen >= BUSY_STALE_MS ? "unknown" : "busy";
  return "unknown";
}
