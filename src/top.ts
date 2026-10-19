import { AGENT_IDS, kindLabel } from "./agents/types.ts";
import type { Broker } from "./broker.ts";
import type { SessionKind } from "./channels.ts";
import { isRemoteThread } from "./gateway/policy.ts";
import { cleanText, squash } from "./limits.ts";
import { since, span } from "./render.ts";
import { driverOfThread, median, peerStatus } from "./status.ts";
import { VERSION } from "./version.ts";

export interface TopPeer {
  name: string;
  kind: SessionKind;
  agent?: string;
  state: string;
  task: string | null;
  unread: number;
  held: number;
  tasks: number;
  lastMessage: { at: number; from: string } | null;
  driver?: string;
}

export interface TopToday {
  since: number;
  routed: number;
  paused: number;
  batched: number;
  merged: number;
  interruptsAvoided: number;
  digestsFlushed: number;
  shown: number;
  medianMsToShown: number | null;
}

export interface TopSnapshot {
  at: number;
  version: string;
  peers: TopPeer[];
  today: TopToday;
}

export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const SENDER_LABEL = new RegExp(` \\((?:claude|remote|${AGENT_IDS.join("|")})\\)$`);

const one = (broker: Broker, sql: string, ...args: (string | number)[]): Record<string, number | string | null> => broker.store.db.prepare(sql).get(...args) as Record<string, number | string | null>;

function lastMessage(broker: Broker, addr: string, threadId: string | undefined): TopPeer["lastMessage"] {
  const sent = one(broker, "SELECT from_name AS who, created_at AS at FROM outbox WHERE to_addr = ? AND status NOT IN ('refused', 'failed', 'merged') ORDER BY created_at DESC LIMIT 1", addr);
  const received = threadId ? one(broker, "SELECT from_name AS who, received_at AS at FROM messages WHERE to_thread = ? AND kind = 'message' ORDER BY received_at DESC LIMIT 1", threadId) : undefined;
  const latest = [sent, received].filter((r): r is Record<string, number | string | null> => !!r && r.at !== null && r.at !== undefined).sort((a, b) => Number(b.at) - Number(a.at))[0];
  return latest ? { at: Number(latest.at), from: cleanText(latest.who, 64).replace(SENDER_LABEL, "") || "unknown" } : null;
}

function today(broker: Broker, now: number): TopToday {
  const from = startOfDay(now);
  const live = "status NOT IN ('refused', 'failed')";
  const routed = one(broker, `SELECT COUNT(*) AS n, COALESCE(SUM(route = 'pause'), 0) AS paused, COALESCE(SUM(route = 'digest'), 0) AS batched, COALESCE(SUM(route = 'merge'), 0) AS merged FROM outbox WHERE created_at >= ? AND ${live}`, from);
  const claudeDigests = one(broker, "SELECT COUNT(DISTINCT carrier_id) AS n FROM outbox WHERE carrier_id IS NOT NULL AND sent_at >= ?", from);
  const codexDigests = one(broker, "SELECT COUNT(*) AS n FROM (SELECT DISTINCT to_thread, released_at FROM messages WHERE route = 'digest' AND released_at >= ?)", from);
  const native = one(broker, `SELECT COUNT(*) AS n, COALESCE(SUM(route = 'pause'), 0) AS paused, COALESCE(SUM(route = 'digest'), 0) AS batched FROM messages m WHERE kind = 'message' AND received_at >= ? AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.msg_id = m.msg_id AND o.to_thread = m.to_thread)`, from);
  const waits = (broker.store.db.prepare(`SELECT shown_at - created_at AS wait FROM outbox WHERE created_at >= ? AND shown_at IS NOT NULL AND ${live}`).all(from) as { wait: number }[]).map((r) => Number(r.wait));
  const paused = Number(routed.paused) + Number(native.paused);
  const batched = Number(routed.batched) + Number(native.batched);
  const merged = Number(routed.merged);
  return {
    since: from,
    routed: Number(routed.n) + Number(native.n),
    paused,
    batched,
    merged,
    interruptsAvoided: paused + batched + merged,
    digestsFlushed: Number(claudeDigests.n) + Number(codexDigests.n),
    shown: waits.length,
    medianMsToShown: median(waits),
  };
}

export function topSnapshot(broker: Broker, now: number = Date.now()): TopSnapshot {
  const peers = broker.liveTargets({ remote: true }).map((target): TopPeer => {
    const ref = broker.peerRef(target);
    const status = peerStatus(broker.store, ref, now);
    const remote = ref.thread !== undefined && isRemoteThread(broker, ref.thread.thread_id);
    const driver = driverOfThread(broker.store, ref.thread);
    return {
      name: cleanText(ref.name, 64),
      kind: remote ? "remote" : ref.kind,
      ...(!remote && ref.thread && ref.thread.agent !== "codex" && { agent: ref.thread.agent }),
      state: status.actual.state,
      task: status.actual.currentTask,
      unread: status.desired.unreadMessages,
      held: status.desired.heldDigests,
      tasks: status.desired.openTasks.length,
      lastMessage: lastMessage(broker, ref.addr, ref.thread?.thread_id),
      ...(driver && { driver: driver.name }),
    };
  });
  return { at: now, version: VERSION, peers, today: today(broker, now) };
}

export interface RenderOptions {
  width: number;
  color: boolean;
  now: number;
  hint?: boolean;
}

function layout(width: number, longest: number, kind: number): { name: number; last: number; task: number } {
  const name = Math.max(4, Math.min(width >= 100 ? 24 : width >= 80 ? 12 : 10, longest));
  const room = width - (name + 2 + kind + 2 + 8 + 2 + 6 + 2 + 4 + 2 + 5 + 2);
  const last = room >= 22 + 2 + TASK_MIN ? 22 : room >= 14 + 2 + TASK_MIN ? 14 : Math.max(0, Math.min(22, room));
  const task = room - last - 2;
  return { name, last, task: task >= TASK_MIN ? task : 0 };
}

const TASK_MIN = 10;
const cut = (text: string, width: number): string => (width <= 0 ? "" : text.length <= width ? text : width === 1 ? "…" : `${text.slice(0, width - 1)}…`);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const STATE_COLOR: Record<string, string> = { idle: "32", busy: "33", waiting: "36" };

const shown = (p: TopPeer): string => (p.driver ? `${p.name} (driver ${p.driver})` : p.name);

export function renderTop(snap: TopSnapshot, o: RenderOptions): string {
  const width = Math.max(60, o.width);
  const paint = (code: string, text: string): string => (o.color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const lines = [
    `${paint("1", `agentsocks ${snap.version}`)}  ${new Date(o.now).toTimeString().slice(0, 8)}${o.hint ? "  q to quit" : ""}`,
  ];
  if (snap.peers.length === 0) lines.push("", "No live sessions.");
  else {
    const kind = Math.max(6, ...snap.peers.map((p) => kindLabel(p.kind, p.agent).length));
    const { name, last, task } = layout(width, Math.max(...snap.peers.map((p) => shown(p).length)), kind);
    const header = [cut("PEER", name).padEnd(name), "KIND".padEnd(kind), "STATE".padEnd(8), "UNREAD".padStart(6), "HELD".padStart(4), "TASKS".padStart(5), cut("LAST MESSAGE", last).padEnd(last)];
    lines.push("", paint("2", [...header, ...(task > 0 ? [cut("CURRENT TASK", task)] : [])].join("  ").trimEnd()));
    for (const p of snap.peers) {
      const when = p.lastMessage ? cut(`${since(p.lastMessage.at, o.now)} @${p.lastMessage.from}`, last) : "-";
      const state = paint(STATE_COLOR[p.state] ?? "0", p.state.slice(0, 8).padEnd(8));
      const cells = [cut(shown(p), name).padEnd(name), kindLabel(p.kind, p.agent).padEnd(kind), state, String(p.unread).padStart(6), String(p.held).padStart(4), String(p.tasks).padStart(5), when.padEnd(last)];
      lines.push([...cells, ...(task > 0 ? [cut(p.task ? squash(p.task, 200) : "-", task)] : [])].join("  ").trimEnd());
    }
  }
  const t = snap.today;
  const median = t.medianMsToShown === null ? "n/a" : `${span(t.medianMsToShown)} (${t.shown} shown)`;
  const footer: [string, string][] = [
    ["", `${plural(t.routed, "message", "messages")} routed`],
    [", ", `${plural(t.interruptsAvoided, "interrupt", "interrupts")} avoided`],
    [" ", `(${t.paused} paused, ${t.batched} batched, ${t.merged} merged)`],
    [", ", `${plural(t.digestsFlushed, "digest", "digests")} flushed`],
    [", ", `median time to shown ${median}`],
  ];
  lines.push("", ...wrap("Today: ", footer, width).map((l) => paint("2", l)));
  return lines.join("\n");
}

function wrap(lead: string, parts: [string, string][], width: number): string[] {
  const out: string[] = [];
  const indent = " ".repeat(lead.length);
  let line = lead;
  let fresh = true;
  for (const [sep, text] of parts) {
    if (!fresh && line.length + sep.length + text.length >= width) {
      out.push(sep.startsWith(",") ? `${line},` : line);
      line = indent;
      fresh = true;
    }
    line += fresh ? text : `${sep}${text}`;
    fresh = false;
  }
  out.push(line);
  return out;
}
