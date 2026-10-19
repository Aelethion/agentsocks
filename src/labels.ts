import type { DatabaseSync } from "node:sqlite";
import { audit } from "./audit.ts";
import type { EvalCase } from "./evalrouter.ts";
import { cleanText, squash } from "./limits.ts";
import { redactSecrets } from "./redact.ts";
import type { Route } from "./router.ts";
import type { Party } from "./routing.ts";
import type { MessageRow, OutboxRow } from "./store.ts";
import { whoIs } from "./views.ts";

export type Rating = "useful-now" | "could-wait" | "noise";
export const RATINGS: readonly Rating[] = ["useful-now", "could-wait", "noise"];
export const ROUTE_OF: Record<Rating, Exclude<Route, "merge">> = { "useful-now": "now", "could-wait": "pause", noise: "digest" };

export const LABEL_TEXT_CHARS = 2000;
export const LABEL_KEEP_MS = 180 * 86_400_000;
export const SENDER_WINDOW_MS = 30 * 86_400_000;
export const REPLIED_WITHIN_MS = 10 * 60_000;
export const NEVER_READ_AFTER_MS = 2 * 3_600_000;
export const ACTIVE_AFTER_SEND_MS = 5 * 60_000;
const COLLECT_EVERY_MS = 60_000;
const COLLECT_WINDOW_MS = 3 * 86_400_000;
const RECENT_SCAN = 1000;
const PAGE_ROWS = 1000;
const PAGE_BYTES = 600_000;
const BODY_CACHE_SIZE = 256;
export const BODY_CACHE_MS = 2 * 3_600_000;

const FAN_OUT_ID = /^(?:([0-9A-Za-z_.:-]{1,100}):[0-9a-f]{10}|(A-[0-9a-f]{6}):\d{1,2})$/;

export const sendOf = (msgId: string): string => {
  const hit = FAN_OUT_ID.exec(msgId);
  return hit?.[1] ?? hit?.[2] ?? msgId;
};

export const parseRating = (raw: unknown): Rating => {
  if (typeof raw === "string" && (RATINGS as readonly string[]).includes(raw)) return raw as Rating;
  throw new Error(`rating must be one of ${RATINGS.join(", ")}`);
};

export class BodyCache {
  private readonly entries = new Map<string, { text: string; at: number }>();

  remember(msgId: string, body: string, now = Date.now()): void {
    this.entries.delete(msgId);
    this.entries.set(msgId, { text: redactSecrets(body).slice(0, LABEL_TEXT_CHARS), at: now });
    while (this.entries.size > BODY_CACHE_SIZE) this.entries.delete(this.entries.keys().next().value!);
  }

  get(msgId: string, now = Date.now()): string | undefined {
    const hit = this.entries.get(msgId);
    return hit && now - hit.at < BODY_CACHE_MS ? hit.text : undefined;
  }
}

export interface SenderRatings {
  rated: number;
  low: number;
}

export interface LabelExport {
  v: 1;
  at: string;
  source: "explicit" | "implicit";
  reason: string;
  rating: Rating;
  decision: Exclude<Route, "merge">;
  task: string | null;
  message: string | null;
  last_tool: string | null;
  receiver: { kind: string };
  sender: { name: string | null; kind: string | null };
  urgency: string | null;
  routed: { route: Route; by: string | null; rule: string | null; confidence: number | null };
  msg_id: string;
}

interface LabelRow {
  id: number;
  msg_id: string;
  source: "explicit" | "implicit";
  rating: Rating;
  reason: string;
  created_at: number;
  msg_at: number;
  receiver_addr: string;
  receiver_name: string | null;
  receiver_kind: string;
  sender_key: string;
  sender_name: string | null;
  sender_kind: string | null;
  urgency: string | null;
  route: Route;
  decided_by: string | null;
  rule: string | null;
  confidence: number | null;
  task: string | null;
  last_tool: string | null;
  body: string | null;
}

type NewLabel = Omit<LabelRow, "id">;

export interface LabelDeps {
  db: DatabaseSync;
  canon(addr: string | null | undefined): string | null;
  receiverContext(party: Party): { task?: string; lastTool?: string };
  bodyOf(msgId: string): string | undefined;
}

export interface RateResult {
  msgId: string;
  from: string;
  rating: Rating;
  withText: boolean;
}

const decisionOf = (json: string | null): { by: string | null; rule: string | null; confidence: number | null; urgency: string | null } => {
  try {
    const d = JSON.parse(json ?? "{}") as { by?: unknown; rule?: unknown; confidence?: unknown; urgency?: unknown };
    return {
      by: typeof d.by === "string" ? d.by : null,
      rule: typeof d.rule === "string" ? d.rule : null,
      confidence: typeof d.confidence === "number" ? d.confidence : null,
      urgency: typeof d.urgency === "string" ? d.urgency : null,
    };
  } catch {
    return { by: null, rule: null, confidence: null, urgency: null };
  }
};

export class LabelService {
  private readonly deps: LabelDeps;
  private lastCollect = 0;

  constructor(deps: LabelDeps) {
    this.deps = deps;
  }

  private put(l: NewLabel): void {
    this.deps.db
      .prepare(
        `INSERT INTO labels (msg_id, source, rating, reason, created_at, msg_at, receiver_addr, receiver_name, receiver_kind, sender_key, sender_name, sender_kind, urgency, route, decided_by, rule, confidence, task, last_tool, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (msg_id, receiver_addr, source) DO UPDATE SET rating = excluded.rating, reason = excluded.reason, created_at = excluded.created_at, task = excluded.task, last_tool = excluded.last_tool, body = COALESCE(excluded.body, labels.body)`,
      )
      .run(l.msg_id, l.source, l.rating, l.reason, l.created_at, l.msg_at, l.receiver_addr, l.receiver_name, l.receiver_kind, l.sender_key, l.sender_name, l.sender_kind, l.urgency, l.route, l.decided_by, l.rule, l.confidence, l.task, l.last_tool, l.body);
  }

  private found(caller: Party, ref: { msgId?: unknown; from?: unknown }): { label: Omit<NewLabel, "source" | "rating" | "reason" | "created_at" | "task" | "last_tool">; senderName: string } | undefined {
    const db = this.deps.db;
    const msgId = typeof ref.msgId === "string" && ref.msgId ? ref.msgId : undefined;
    const from = typeof ref.from === "string" && ref.from.trim() ? ref.from.trim().replace(/^@/, "").toLowerCase() : undefined;
    const fromMatches = (name: string | null, kind: string | null): boolean => {
      const n = (name ?? "").toLowerCase();
      return !from || n === from || n.startsWith(`${from} (`) || (kind !== null && `${n} (${kind})` === from);
    };
    const receiverAddr = this.deps.canon(caller.addr);
    if (!receiverAddr) return undefined;
    if (caller.kind === "codex" || caller.kind === "remote") {
      if (!caller.session) return undefined;
      const heads = (msgId
        ? db.prepare("SELECT id, from_name, from_kind FROM messages WHERE to_thread = ? AND kind = 'message' AND state = 'surfaced' AND msg_id = ? LIMIT 1").all(caller.session, msgId)
        : db.prepare("SELECT id, from_name, from_kind FROM messages WHERE to_thread = ? AND kind = 'message' AND state = 'surfaced' ORDER BY received_at DESC LIMIT ?").all(caller.session, RECENT_SCAN)) as unknown as { id: string; from_name: string | null; from_kind: string | null }[];
      const head = heads.find((r) => fromMatches(r.from_name, r.from_kind));
      const m = head && (db.prepare("SELECT * FROM messages WHERE id = ?").get(head.id) as MessageRow | undefined);
      if (!m) return undefined;
      const d = decisionOf(m.decision);
      return {
        senderName: m.from_name ?? "unknown",
        label: {
          msg_id: m.msg_id,
          msg_at: m.received_at,
          receiver_addr: receiverAddr,
          receiver_name: caller.name,
          receiver_kind: caller.kind,
          sender_key: whoIs(this.deps.canon(m.from_addr), m.from_name).key,
          sender_name: m.from_name,
          sender_kind: m.from_kind,
          urgency: d.urgency,
          route: m.route,
          decided_by: d.by,
          rule: d.rule,
          confidence: d.confidence,
          body: redactSecrets(m.body).slice(0, LABEL_TEXT_CHARS),
        },
      };
    }
    const delivered = "(to_addr = ? OR (to_session IS NOT NULL AND to_session = ?)) AND (status IN ('shown', 'replied') OR (status = 'sent' AND route = 'now'))";
    const heads = (msgId
      ? db.prepare(`SELECT id, from_name, from_kind FROM outbox WHERE ${delivered} AND msg_id = ? LIMIT 1`).all(receiverAddr, caller.session ?? "", msgId)
      : db.prepare(`SELECT id, from_name, from_kind FROM outbox WHERE ${delivered} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(receiverAddr, caller.session ?? "", RECENT_SCAN)) as unknown as { id: string; from_name: string | null; from_kind: string | null }[];
    const head = heads.find((r) => fromMatches(r.from_name, r.from_kind));
    const o = head && (db.prepare("SELECT * FROM outbox WHERE id = ?").get(head.id) as OutboxRow | undefined);
    if (!o) return undefined;
    const d = decisionOf(o.decision);
    return {
      senderName: o.from_name,
      label: {
        msg_id: o.msg_id,
        msg_at: o.created_at,
        receiver_addr: o.to_addr,
        receiver_name: o.to_name,
        receiver_kind: o.to_kind,
        sender_key: whoIs(o.from_addr, o.from_name).key,
        sender_name: o.from_name,
        sender_kind: o.from_kind,
        urgency: o.urgency,
        route: o.route,
        decided_by: d.by,
        rule: d.rule,
        confidence: d.confidence,
        body: this.deps.bodyOf(o.msg_id) ?? null,
      },
    };
  }

  rate(caller: Party, rawRating: unknown, ref: { msgId?: unknown; from?: unknown }, now = Date.now()): RateResult {
    const rating = parseRating(rawRating);
    if (caller.kind === "cli" || !caller.addr) throw new Error("only a Claude Code or Codex session can rate a message: a plain shell receives none");
    const hit = this.found(caller, ref);
    if (!hit) {
      const seen = "a message counts once you have seen it";
      throw new Error(ref.msgId ? `no message ${cleanText(ref.msgId, 80)} was delivered to you through agentsocks (${seen})` : `no message from that sender was delivered to you through agentsocks (${seen})`);
    }
    const context = this.deps.receiverContext(caller);
    this.put({
      ...hit.label,
      source: "explicit",
      rating,
      reason: "rated",
      created_at: now,
      task: context.task ? squash(redactSecrets(context.task), 200) : null,
      last_tool: context.lastTool ?? null,
    });
    this.purge(now);
    audit("label", { msg: hit.label.msg_id, rating, source: "explicit" });
    return { msgId: hit.label.msg_id, from: hit.senderName, rating, withText: hit.label.body !== null };
  }

  ratingsFor(senderKey: string, now: number): SenderRatings | undefined {
    const rows = this.deps.db
      .prepare("SELECT msg_id, receiver_addr, source, rating FROM labels WHERE sender_key = ? AND route = 'now' AND msg_at >= ? ORDER BY msg_at DESC LIMIT 500")
      .all(senderKey, now - SENDER_WINDOW_MS) as { msg_id: string; receiver_addr: string; source: string; rating: Rating }[];
    if (rows.length === 0) return undefined;
    const byDelivery = new Map<string, { source: string; rating: Rating }>();
    for (const r of rows) {
      const key = `${r.msg_id}|${r.receiver_addr}`;
      const have = byDelivery.get(key);
      if (!have || (have.source !== "explicit" && r.source === "explicit")) byDelivery.set(key, r);
    }
    const bySend = new Map<string, { rated: number; low: number }>();
    for (const [key, d] of byDelivery) {
      const send = sendOf(key.slice(0, key.indexOf("|")));
      const tally = bySend.get(send) ?? { rated: 0, low: 0 };
      tally.rated++;
      if (d.rating !== "useful-now") tally.low++;
      bySend.set(send, tally);
    }
    const sends = [...bySend.values()];
    return { rated: sends.length, low: sends.filter((t) => t.low * 2 >= t.rated).length };
  }

  collect(now: number, force = false): number {
    if (!force && now - this.lastCollect < COLLECT_EVERY_MS) return 0;
    this.lastCollect = now;
    const db = this.deps.db;
    const rows = db
      .prepare(
        `SELECT o.* FROM outbox o WHERE o.created_at >= ? AND o.created_at <= ?
           AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.msg_id = o.msg_id AND l.receiver_addr = o.to_addr AND l.source = 'implicit')
           AND (
             (o.status = 'merged' AND o.error IS NULL)
             OR (o.replied_at IS NOT NULL AND o.replied_at - o.created_at <= ?)
             OR (o.to_kind = 'codex' AND o.route IN ('now', 'pause') AND o.status = 'sent' AND o.shown_at IS NULL AND COALESCE(o.sent_at, o.created_at) <= ?
                 AND EXISTS (SELECT 1 FROM threads t WHERE t.thread_id = o.to_thread AND t.last_activity IS NOT NULL AND t.last_activity > COALESCE(o.sent_at, o.created_at) + ?))
           )`,
      )
      .all(now - COLLECT_WINDOW_MS, now, REPLIED_WITHIN_MS, now - NEVER_READ_AFTER_MS, ACTIVE_AFTER_SEND_MS) as unknown as OutboxRow[];
    for (const o of rows) {
      const d = decisionOf(o.decision);
      const merged = o.status === "merged";
      const replied = !merged && o.replied_at !== null && o.replied_at - o.created_at <= REPLIED_WITHIN_MS;
      this.put({
        msg_id: o.msg_id,
        source: "implicit",
        rating: replied ? "useful-now" : "noise",
        reason: merged ? "merged" : replied ? "replied" : "never-read",
        created_at: now,
        msg_at: o.created_at,
        receiver_addr: o.to_addr,
        receiver_name: o.to_name,
        receiver_kind: o.to_kind,
        sender_key: whoIs(o.from_addr, o.from_name).key,
        sender_name: o.from_name,
        sender_kind: o.from_kind,
        urgency: o.urgency,
        route: o.route,
        decided_by: d.by,
        rule: d.rule,
        confidence: d.confidence,
        task: null,
        last_tool: null,
        body: null,
      });
    }
    this.purge(now);
    return rows.length;
  }

  private purge(now: number): void {
    this.deps.db.prepare("DELETE FROM labels WHERE msg_at < ?").run(now - LABEL_KEEP_MS);
  }

  export(opts: { sinceMs?: number; textOnly?: boolean; afterId?: number; maxBytes?: number } = {}): { rows: LabelExport[]; next: number | null } {
    const where = ["id > ?", ...(opts.sinceMs !== undefined ? ["created_at >= ?"] : []), ...(opts.textOnly ? ["body IS NOT NULL"] : [])];
    const args = [opts.afterId ?? 0, ...(opts.sinceMs !== undefined ? [opts.sinceMs] : []), PAGE_ROWS + 1];
    const found = this.deps.db.prepare(`SELECT * FROM labels WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`).all(...args) as unknown as LabelRow[];
    const rows: LabelExport[] = [];
    let bytes = 0;
    let last: number | null = null;
    for (const l of found.slice(0, PAGE_ROWS)) {
      const row = exported(l);
      const size = JSON.stringify(row).length;
      if (rows.length > 0 && bytes + size > (opts.maxBytes ?? PAGE_BYTES)) break;
      rows.push(row);
      bytes += size;
      last = l.id;
    }
    return { rows, next: rows.length < found.length ? last : null };
  }
}

const exported = (l: LabelRow): LabelExport => ({
  v: 1,
  at: new Date(l.created_at).toISOString(),
  source: l.source,
  reason: l.reason,
  rating: l.rating,
  decision: ROUTE_OF[l.rating],
  task: l.task,
  message: l.body,
  last_tool: l.last_tool,
  receiver: { kind: l.receiver_kind },
  sender: { name: l.sender_name, kind: l.sender_kind },
  urgency: l.urgency,
  routed: { route: l.route, by: l.decided_by, rule: l.rule, confidence: l.confidence },
  msg_id: l.msg_id,
});

export function formatRate(r: RateResult): string {
  return `Rated the message from @${r.from} as ${r.rating}. It is stored on this machine${r.withText ? ", with its text," : ", without its text (it is no longer in memory),"} and only tunes how agentsocks routes that sender's messages and scores the router on your own traffic.`;
}

export function labelCases(labels: LabelExport[]): EvalCase[] {
  return labels.filter((l) => l.message !== null).map((l) => ({ task: l.task ?? "", message: l.message!, decision: l.decision }));
}

export interface AsRouted {
  labels: number;
  explicit: number;
  withText: number;
  judged: number;
  matched: number;
  deliveredNowButLow: number;
}

export function asRouted(labels: LabelExport[]): AsRouted {
  const judged = labels.filter((l) => l.source === "explicit" && l.routed.route !== "merge");
  return {
    labels: labels.length,
    explicit: labels.filter((l) => l.source === "explicit").length,
    withText: labels.filter((l) => l.message !== null).length,
    judged: judged.length,
    matched: judged.filter((l) => l.routed.route === l.decision).length,
    deliveredNowButLow: judged.filter((l) => l.routed.route === "now" && l.decision !== "now").length,
  };
}

export function formatOwn(a: AsRouted): string {
  const pct = a.judged === 0 ? "n/a" : `${Math.round((a.matched / a.judged) * 1000) / 10}%`;
  return [
    `Your own traffic: ${a.labels} labelled messages (${a.explicit} rated by receivers, ${a.labels - a.explicit} from signals), ${a.withText} with text, which is what is replayed above as a busy receiver and urgency normal.`,
    `As routed at the time, over the ${a.judged} rated by receivers: ${a.matched} routes matched the rating (${pct}); ${a.deliveredNowButLow} were delivered now to a receiver that rated the message could-wait or noise.`,
  ].join("\n");
}
