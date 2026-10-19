import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SendError } from "./ccsocks.ts";
import { agentFieldOf, kindLabel, type InboxAgentId } from "./agents/types.ts";
import { audit } from "./audit.ts";
import { mapLimit } from "./fanout.ts";
import { decodeAddress } from "./envelope.ts";
import { MAX_BODY_BYTES, bodyTooLarge, cleanText, sha256 } from "./limits.ts";
import { killSwitchOn } from "./paths.ts";
import type { Route, Urgency } from "./router.ts";
import { digestWait, driverInfoNote, type Party, type Reach, type RouteSendResult, type Target } from "./routing.ts";

export type SessionKind = "claude" | "codex" | "remote";

export const BROADCAST = "all";
export const FANOUT_CONCURRENCY = 3;
export const MAX_SUBSCRIPTIONS = 32;
export const MAX_POST_RECIPIENTS = 64;
const LIST_CHANNELS = 50;
const LIST_MEMBERS = 20;
const NOT_RUNNING_NAMES = 10;
export const MEMBER_KEEP_MS = 30 * 86_400_000;
const UPKEEP_EVERY_MS = 3_600_000;
const CHANNEL = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export const refOf = (addr: string): string => sha256(decodeAddress(addr) ?? addr).slice(0, 6);

export function labeller(items: readonly { name: string; ref: string }[]): (item: { name: string; ref: string }) => string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + 1);
  return (item) => `@${item.name}${(counts.get(item.name) ?? 0) > 1 ? ` [${item.ref}]` : ""}`;
}

export const isChannelAddress = (to: string): boolean => to.trim().startsWith("#");

export function parseChannel(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().replace(/^#/, "").toLowerCase() : "";
  if (!CHANNEL.test(name)) throw new Error(`"${cleanText(raw, 60)}" is not a channel name: use # and up to 48 letters, digits, dots, dashes or underscores, for example #deploys`);
  return name;
}

export interface Member {
  channel: string;
  member: string;
  addr: string;
  name: string;
  kind: SessionKind;
  session: string | null;
  subscribed_at: number;
  last_seen: number;
}

export interface MemberView {
  name: string;
  ref: string;
  kind: SessionKind;
  agent?: InboxAgentId;
  you: boolean;
  live: boolean;
}

export interface ChannelChange {
  channel: string;
  changed: boolean;
  members: MemberView[];
  memberCount: number;
}

export interface ChannelList {
  channels: { channel: string; members: MemberView[]; memberCount: number }[];
  moreChannels: number;
}

export interface Delivery {
  name: string;
  ref: string;
  kind: SessionKind;
  agent?: InboxAgentId;
  outcome: "delivered" | "batched" | "merged" | "native" | "failed";
  msgId?: string;
  route?: Route;
  reason?: string;
  driver?: string;
  error?: string;
}

export interface PostResult {
  channel: string;
  recipients: number;
  deliveries: Delivery[];
  notRunning: { count: number; names: { name: string; ref: string; kind: SessionKind; agent?: InboxAgentId }[] };
}

export class ChannelStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(channel: string, member: string): Member | undefined {
    return this.db.prepare("SELECT * FROM channel_members WHERE channel = ? AND member = ?").get(channel, member) as Member | undefined;
  }

  upsert(m: Member): void {
    this.db
      .prepare(
        `INSERT INTO channel_members (channel, member, addr, name, kind, session, subscribed_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel, member) DO UPDATE SET addr = excluded.addr, name = excluded.name, kind = excluded.kind, session = excluded.session, last_seen = excluded.last_seen`,
      )
      .run(m.channel, m.member, m.addr, m.name, m.kind, m.session, m.subscribed_at, m.last_seen);
  }

  countFor(member: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM channel_members WHERE member = ?").get(member) as { n: number }).n);
  }

  remove(channel: string, member: string): boolean {
    return Number(this.db.prepare("DELETE FROM channel_members WHERE channel = ? AND member = ?").run(channel, member).changes) > 0;
  }

  of(channel: string): Member[] {
    return this.db.prepare("SELECT * FROM channel_members WHERE channel = ? ORDER BY subscribed_at, member").all(channel) as unknown as Member[];
  }

  all(): Member[] {
    return this.db.prepare("SELECT * FROM channel_members ORDER BY channel, subscribed_at, member").all() as unknown as Member[];
  }

  touch(channel: string, member: string, now: number): void {
    this.db.prepare("UPDATE channel_members SET last_seen = ? WHERE channel = ? AND member = ?").run(now, channel, member);
  }

  prune(cutoff: number): number {
    return Number(this.db.prepare("DELETE FROM channel_members WHERE last_seen < ?").run(cutoff).changes);
  }
}

export interface ChannelDeps {
  db: DatabaseSync;
  send(request: Record<string, unknown>): Promise<RouteSendResult>;
  targetOf(addr: string, name: string, session: string | null): Target;
  canon(addr: string | null | undefined): string | null;
  live(opts?: { everyone?: boolean; remote?: boolean }): Target[];
  mayReach(from: Party, to: Reach): boolean;
}

export interface Recipient {
  key: string;
  addr: string;
  name: string;
  kind: SessionKind;
  session: string | null;
}

export function recipientOf(t: Target, canon: (addr: string | null | undefined) => string | null): Recipient {
  const session = (t.kind === "codex" ? t.threadId : t.sessionId) ?? null;
  const addr = canon(t.addr) ?? t.addr;
  return { key: session ?? addr, addr, name: t.name, kind: t.kind, session };
}

function outcomeOf(r: RouteSendResult): Delivery["outcome"] {
  if (r.status === "failed" || r.status === "refused") return "failed";
  if (r.decision.route === "merge") return "merged";
  return r.decision.route === "digest" ? "batched" : "delivered";
}

export class ChannelService {
  private readonly deps: ChannelDeps;
  private readonly store: ChannelStore;
  private lastUpkeep = 0;

  constructor(deps: ChannelDeps) {
    this.deps = deps;
    this.store = new ChannelStore(deps.db);
  }

  members(channel: string): Member[] {
    return this.store.of(channel);
  }

  private keyOfParty(p: Party): string | null {
    return p.session ?? this.deps.canon(p.addr);
  }

  private keyOfTarget(t: Target): string {
    return recipientOf(t, this.deps.canon).key;
  }

  private liveKeys(): Set<string> {
    return new Set(this.deps.live({ everyone: true, remote: true }).map((t) => this.keyOfTarget(t)));
  }

  private visible(members: Member[], party: Party | undefined): Member[] {
    if (!party) return members;
    const me = this.keyOfParty(party);
    return members.filter((m) => m.member === me || this.deps.mayReach(party, m));
  }

  private views(members: Member[], party: Party | undefined, live: Set<string>): MemberView[] {
    const me = party ? this.keyOfParty(party) : null;
    return members.map((m) => ({ name: m.name, ref: refOf(m.addr), kind: m.kind, ...agentFieldOf(m.session), you: me !== null && m.member === me, live: live.has(m.member) }));
  }

  subscribe(party: Party, rawChannel: unknown, now = Date.now()): ChannelChange {
    const channel = parseChannel(rawChannel);
    if (channel === BROADCAST) throw new Error("#all is every live session, so there is nothing to subscribe to");
    if (party.kind === "cli" || !party.addr) throw new Error("only a Claude Code or Codex session can subscribe: a plain shell has no inbox to deliver to");
    const member = this.keyOfParty(party)!;
    const existing = this.store.get(channel, member);
    if (!existing && this.store.countFor(member) >= MAX_SUBSCRIPTIONS) throw new Error(`you are already subscribed to ${MAX_SUBSCRIPTIONS} channels; unsubscribe from one first`);
    this.store.upsert({ channel, member, addr: this.deps.canon(party.addr) ?? party.addr, name: party.name, kind: party.kind, session: party.session, subscribed_at: existing?.subscribed_at ?? now, last_seen: now });
    return this.change(channel, !existing, party);
  }

  unsubscribe(party: Party, rawChannel: unknown): ChannelChange {
    const channel = parseChannel(rawChannel);
    const member = this.keyOfParty(party);
    const changed = member !== null && this.store.remove(channel, member);
    return this.change(channel, changed, party);
  }

  private change(channel: string, changed: boolean, party: Party): ChannelChange {
    const members = this.visible(this.store.of(channel), party);
    return { channel, changed, members: this.views(members.slice(0, LIST_MEMBERS), party, this.liveKeys()), memberCount: members.length };
  }

  list(party: Party | undefined): ChannelList {
    const byChannel = new Map<string, Member[]>();
    for (const m of this.visible(this.store.all(), party)) byChannel.set(m.channel, [...(byChannel.get(m.channel) ?? []), m]);
    const live = this.liveKeys();
    const channels = [...byChannel].slice(0, LIST_CHANNELS).map(([channel, members]) => ({ channel, members: this.views(members.slice(0, LIST_MEMBERS), party, live), memberCount: members.length }));
    return { channels, moreChannels: Math.max(0, byChannel.size - LIST_CHANNELS) };
  }

  expand(channel: string, from: Party, opts: { liveOnly?: boolean } = {}): Recipient[] {
    if (channel === BROADCAST && from.kind === "remote") throw new Error("a remote peer cannot address #all: it is for the sessions on this machine, so message the sessions you need by name or post to a channel");
    const self = this.keyOfParty(from);
    const live = opts.liveOnly && channel !== BROADCAST ? this.liveKeys() : undefined;
    const all: Recipient[] =
      channel === BROADCAST
        ? this.deps.live().map((t) => recipientOf(t, this.deps.canon))
        : this.store.of(channel).map((m) => ({ key: m.member, addr: m.addr, name: m.name, kind: m.kind, session: m.session }));
    const seen = new Set<string>();
    return all.filter((r) => r.key !== self && !seen.has(r.key) && (!live || live.has(r.key)) && this.deps.mayReach(from, r) && !!seen.add(r.key));
  }

  async post(input: { from: Party; channel: unknown; body: unknown; urgency: Urgency; requestId?: string }): Promise<PostResult> {
    if (killSwitchOn()) throw new SendError("off", "agentsocks is switched off on this machine (kill switch)");
    const channel = parseChannel(input.channel);
    if (typeof input.body !== "string" || !input.body.trim()) throw new Error("message is empty");
    if (channel === BROADCAST && input.urgency === "urgent") throw new Error("an urgent broadcast is refused: urgent is for one session's blocking work, so message the sessions that need it by name, or send the broadcast as normal or fyi");
    const text = `[#${channel}] ${input.body}`;
    if (bodyTooLarge(text)) throw new Error(`message is larger than ${MAX_BODY_BYTES / 1024} KiB; send a file path instead`);
    const recipients = this.expand(channel, input.from);
    const live = channel === BROADCAST ? undefined : this.liveKeys();
    const running = live ? recipients.filter((r) => live.has(r.key)) : recipients;
    const gone = live ? recipients.filter((r) => !live.has(r.key)) : [];
    if (running.length > MAX_POST_RECIPIENTS) throw new Error(`#${channel} has ${running.length} live recipients; a post goes to at most ${MAX_POST_RECIPIENTS}`);
    const request = input.requestId ?? randomUUID();
    const deliveries = await mapLimit(running, FANOUT_CONCURRENCY, (r) => this.deliver(input.from, text, input.urgency, `${request}:${sha256(r.key).slice(0, 10)}`, r));
    const notRunning = { count: gone.length, names: gone.slice(0, NOT_RUNNING_NAMES).map((r) => ({ name: r.name, ref: refOf(r.addr), kind: r.kind, ...agentFieldOf(r.session) })) };
    audit("channel_send", { channel, from: input.from.name, recipients: recipients.length, delivered: deliveries.filter((d) => d.outcome === "delivered" || d.outcome === "batched").length, not_running: gone.length, request }, text);
    return { channel, recipients: recipients.length, deliveries, notRunning };
  }

  private async deliver(from: Party, text: string, urgency: Urgency, msgId: string, r: Recipient): Promise<Delivery> {
    const named = { name: r.name, ref: refOf(r.addr), kind: r.kind, ...agentFieldOf(r.session) };
    if (from.kind === "claude" && r.kind === "claude") return { ...named, outcome: "native" };
    try {
      const routed = await this.deps.send({ msgId, from, to: this.deps.targetOf(r.addr, r.name, r.session), body: text, urgency, via: "channel" });
      return { ...named, outcome: outcomeOf(routed), msgId: routed.msgId, route: routed.decision.route, reason: routed.decision.reason, ...(routed.decision.driverName && { driver: routed.decision.driverName }), ...(routed.error && { error: routed.error }) };
    } catch (err) {
      return { ...named, outcome: "failed", error: (err as Error).message };
    }
  }

  maintain(now: number, force = false): void {
    if (!force && now - this.lastUpkeep < UPKEEP_EVERY_MS) return;
    this.lastUpkeep = now;
    const live = this.liveKeys();
    for (const m of this.store.all()) if (live.has(m.member)) this.store.touch(m.channel, m.member, now);
    this.store.prune(now - MEMBER_KEEP_MS);
  }
}

export function formatChannels(list: ChannelList): string {
  if (list.channels.length === 0) return "No channels yet. Subscribe with the subscribe tool; a channel exists while it has a subscriber.";
  const shown = list.channels.map((c) => {
    const tag = labeller(c.members);
    const names = c.members.map((m) => `${tag(m)}${m.kind === "claude" ? "" : ` (${kindLabel(m.kind, m.agent)})`}${m.you ? " (you)" : ""}${m.live ? "" : " (not running)"}`);
    return `#${c.channel}: ${names.join(", ")}${c.memberCount > c.members.length ? `, and ${c.memberCount - c.members.length} more` : ""}`;
  });
  return [...shown, ...(list.moreChannels > 0 ? [`and ${list.moreChannels} more channels`] : [])].join("\n");
}

export function formatChange(verb: "subscribed" | "unsubscribed", c: ChannelChange): string {
  const tag = labeller(c.members);
  const members = c.memberCount === 0 ? "no subscribers left" : `${c.memberCount} ${c.memberCount === 1 ? "subscriber" : "subscribers"}: ${c.members.map((m) => `${tag(m)}${m.you ? " (you)" : ""}`).join(", ")}${c.memberCount > c.members.length ? `, and ${c.memberCount - c.members.length} more` : ""}`;
  const head = verb === "subscribed" ? (c.changed ? `Subscribed to #${c.channel}` : `You were already subscribed to #${c.channel}`) : c.changed ? `Unsubscribed from #${c.channel}` : `You were not subscribed to #${c.channel}`;
  return `${head}. Now ${members}.${verb === "subscribed" ? ` Post to it with send_message, to set to "#${c.channel}".` : ""}`;
}

function describe(d: Delivery, visible?: readonly string[]): string {
  const note = d.driver && (visible === undefined || visible.includes(d.driver)) ? `. ${driverInfoNote(d.name, d.driver)}` : "";
  switch (d.outcome) {
    case "delivered":
      return `routed ${d.route}, message id ${d.msgId}${note}`;
    case "batched":
      return `batched, they see it ${digestWait(d.kind)}, message id ${d.msgId}${note}`;
    case "merged":
      return `not sent again: the same text reached them in the last 10 minutes, message id ${d.msgId}`;
    default:
      return `not delivered: ${d.error ?? "unknown error"}`;
  }
}

export function formatPost(post: PostResult, visible?: readonly string[]): string {
  if (post.recipients === 0) return `No one but you is subscribed to #${post.channel}, so nothing was sent.`;
  const tag = labeller([...post.deliveries, ...post.notRunning.names]);
  const sent = post.deliveries.filter((d) => d.outcome !== "native");
  const native = post.deliveries.filter((d) => d.outcome === "native");
  const lines =
    sent.length === 0
      ? [`Nothing was posted to #${post.channel} through agentsocks.`]
      : [`Posted to #${post.channel}: ${sent.length} ${sent.length === 1 ? "session" : "sessions"}. Each delivery was routed on its own.`, ...sent.map((d) => `- ${tag(d)} (${kindLabel(d.kind, d.agent)}): ${describe(d, visible)}`)];
  if (native.length > 0) lines.push(`Not posted to ${native.map(tag).join(", ")}: you are a Claude session, so message Claude sessions with your built-in SendMessage.`);
  const gone = post.notRunning;
  if (gone.count > 0) lines.push(`Not running, so not tried: ${gone.names.map((n) => `${tag(n)} (${kindLabel(n.kind, n.agent)})`).join(", ")}${gone.count > gone.names.length ? `, and ${gone.count - gone.names.length} more` : ""}. They stay subscribed.`);
  return lines.join("\n");
}
