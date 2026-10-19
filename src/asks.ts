import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { agentFieldOf, kindLabel, type InboxAgentId } from "./agents/types.ts";
import { SendError } from "./ccsocks.ts";
import { audit } from "./audit.ts";
import { labeller, parseChannel, recipientOf, refOf, type Recipient, type SessionKind } from "./channels.ts";
import type { Classifier } from "./classifier.ts";
import { mapLimit } from "./fanout.ts";
import { MAX_BODY_BYTES, bodyTooLarge } from "./limits.ts";
import { killSwitchOn } from "./paths.ts";
import { pickBest, type PickResult } from "./pick.ts";
import { NOT_FROM_DRIVER_RULE, type Route } from "./router.ts";
import type { Conn } from "./brokerops/types.ts";
import { driverInfoNote, type Party, type Reach, type RouteSendResult, type Target } from "./routing.ts";

export const ASK_MAX_TARGETS = 16;
export const ANSWER_MAX_CHARS = 4000;
export const ASK_KEEP_MS = 14 * 86_400_000;
export const ASK_MIN_SECONDS = 1;
export const ASK_MAX_SECONDS = 280;
const ASK_FANOUT = 3;

export type AskState = "asked" | "answered" | "skipped" | "failed";

interface AskRow {
  id: string;
  from_addr: string | null;
  from_name: string;
  from_kind: string;
  from_session: string | null;
  question: string;
  pick: string | null;
  status: "open" | "closed";
  created_at: number;
  expires_at: number;
  closed_at: number | null;
  pick_result: string | null;
}

interface AskTargetRow {
  ask_id: string;
  ord: number;
  addr: string;
  name: string;
  kind: SessionKind;
  session: string | null;
  state: AskState;
  note: string | null;
  msg_id: string | null;
  route: Route | null;
  answer: string | null;
  answered_at: number | null;
}

export interface AskTargetView {
  name: string;
  ref: string;
  kind: SessionKind;
  agent?: InboxAgentId;
  state: AskState;
  note?: string;
  driver?: string;
  route?: Route;
  msgId?: string;
  answer?: string;
  answeredAfterMs?: number;
}

export interface AskSnapshot {
  id: string;
  question: string;
  status: "open" | "closed";
  createdAt: number;
  expiresAt: number;
  complete: boolean;
  targets: AskTargetView[];
}

export interface AskOutcome {
  ask: AskSnapshot;
  pick?: PickResult;
}

class AskStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  insert(ask: AskRow, targets: Omit<AskTargetRow, "ask_id" | "state" | "note" | "msg_id" | "route" | "answer" | "answered_at">[]): void {
    this.db
      .prepare("INSERT INTO asks (id, from_addr, from_name, from_kind, from_session, question, pick, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
      .run(ask.id, ask.from_addr, ask.from_name, ask.from_kind, ask.from_session, ask.question, ask.pick, ask.created_at, ask.expires_at);
    const add = this.db.prepare("INSERT INTO ask_targets (ask_id, ord, addr, name, kind, session, state) VALUES (?, ?, ?, ?, ?, ?, 'asked')");
    for (const t of targets) add.run(ask.id, t.ord, t.addr, t.name, t.kind, t.session);
  }

  has(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM asks WHERE id = ?").get(id) !== undefined;
  }

  get(id: string): AskRow | undefined {
    return this.db.prepare("SELECT * FROM asks WHERE id = ?").get(id) as AskRow | undefined;
  }

  targets(id: string): AskTargetRow[] {
    return this.db.prepare("SELECT * FROM ask_targets WHERE ask_id = ? ORDER BY ord").all(id) as unknown as AskTargetRow[];
  }

  delivered(id: string, ord: number, msgId: string, route: Route): void {
    this.db.prepare("UPDATE ask_targets SET msg_id = ?, route = ? WHERE ask_id = ? AND ord = ?").run(msgId, route, id, ord);
  }
  driverNote(id: string, ord: number, driver: string): void {
    this.db.prepare("UPDATE ask_targets SET note = ? WHERE ask_id = ? AND ord = ? AND state = 'asked'").run(driver, id, ord);
  }

  settle(id: string, ord: number, state: "skipped" | "failed", note: string): void {
    this.db.prepare("UPDATE ask_targets SET state = ?, note = ? WHERE ask_id = ? AND ord = ? AND state = 'asked'").run(state, note, id, ord);
  }

  answer(id: string, ord: number, text: string, at: number): void {
    this.db.prepare("UPDATE ask_targets SET state = 'answered', answer = ?, answered_at = ? WHERE ask_id = ? AND ord = ? AND state = 'asked'").run(text, at, id, ord);
  }

  close(id: string, at: number): void {
    this.db.prepare("UPDATE asks SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").run(at, id);
  }

  open(): string[] {
    return (this.db.prepare("SELECT id FROM asks WHERE status = 'open'").all() as { id: string }[]).map((r) => r.id);
  }

  setPick(id: string, result: PickResult): void {
    this.db.prepare("UPDATE asks SET pick_result = ? WHERE id = ?").run(JSON.stringify(result), id);
  }

  expired(now: number): string[] {
    return (this.db.prepare("SELECT id FROM asks WHERE status = 'open' AND expires_at <= ?").all(now) as { id: string }[]).map((r) => r.id);
  }

  purge(cutoff: number): void {
    this.db.prepare("DELETE FROM ask_targets WHERE ask_id IN (SELECT id FROM asks WHERE created_at < ?)").run(cutoff);
    this.db.prepare("DELETE FROM asks WHERE created_at < ?").run(cutoff);
  }
}

export interface AskDeps {
  db: DatabaseSync;
  send(request: Record<string, unknown>): Promise<RouteSendResult>;
  targetOf(addr: string, name: string, session: string | null): Target;
  canon(addr: string | null | undefined): string | null;
  holds(caller: Party, addr: string | null, session: string | null): boolean;
  expand(channel: string, from: Party, opts?: { liveOnly?: boolean }): Recipient[];
  mayReach(from: Party, to: Reach): boolean;
  classifier(): Classifier | undefined;
  allow(sender: string): boolean;
}

export function askBody(id: string, asker: string, question: string, asked: number, expiresAt: number): string {
  return [
    `[agentsocks ask ${id}] @${asker} asks you, and is waiting for ${asked === 1 ? "your answer" : `answers from ${asked} sessions`} until ${new Date(expiresAt).toISOString()}:`,
    "",
    question,
    "",
    `Answers arrive through the agentsocks answer tool with ask_id "${id}" (that is how your answer reaches the asker together with the others); a reply sent any other way reaches it as an ordinary message.`,
  ].join("\n");
}

export class AskService {
  private readonly deps: AskDeps;
  private readonly store: AskStore;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly picking = new Map<string, Promise<PickResult>>();

  constructor(deps: AskDeps) {
    this.deps = deps;
    this.store = new AskStore(deps.db);
  }

  private keyOf(p: Party): string | null {
    return p.session ?? this.deps.canon(p.addr);
  }

  private newId(): string {
    for (;;) {
      const id = `A-${randomBytes(3).toString("hex")}`;
      if (!this.store.has(id)) return id;
    }
  }

  async create(input: { from: Party; targets: Target[]; channels: string[]; question: unknown; timeoutSeconds: number; pick?: "best" }): Promise<AskSnapshot> {
    if (killSwitchOn()) throw new SendError("off", "agentsocks is switched off on this machine (kill switch)");
    const { from } = input;
    const question = typeof input.question === "string" ? input.question.replace(/\r\n/g, "\n").trim() : "";
    if (!question) throw new Error("question is empty");
    if (input.targets.length + input.channels.length === 0) throw new Error("name at least one session or channel to ask");
    const self = this.keyOf(from);
    if (!this.deps.allow(self ?? `anon:${from.name}`)) throw new SendError("rate-limited", "too many asks from you just now; try again shortly");
    const recipients = new Map<string, Recipient>();
    for (const t of input.targets) {
      const r = recipientOf(t, this.deps.canon);
      if (r.key !== self && !recipients.has(r.key)) recipients.set(r.key, r);
    }
    for (const channel of input.channels) {
      for (const r of this.deps.expand(parseChannel(channel), from, { liveOnly: true })) if (!recipients.has(r.key)) recipients.set(r.key, r);
    }
    if (recipients.size === 0) throw new Error("no one to ask: the channels named have no subscribers besides you that are running");
    if (recipients.size > ASK_MAX_TARGETS) throw new Error(`an ask goes to at most ${ASK_MAX_TARGETS} sessions (this one reaches ${recipients.size})`);
    const now = Date.now();
    const seconds = Math.min(ASK_MAX_SECONDS, Math.max(ASK_MIN_SECONDS, Math.round(input.timeoutSeconds)));
    const id = this.newId();
    const list = [...recipients.values()];
    const body = askBody(id, from.name, question, list.length, now + seconds * 1000);
    if (bodyTooLarge(body)) throw new Error(`question is larger than ${MAX_BODY_BYTES / 1024} KiB; send a file path instead`);
    this.store.insert(
      { id, from_addr: this.deps.canon(from.addr), from_name: from.name, from_kind: from.kind, from_session: from.session, question, pick: input.pick ?? null, status: "open", created_at: now, expires_at: now + seconds * 1000, closed_at: null, pick_result: null },
      list.map((r, ord) => ({ ord, addr: r.addr, name: r.name, kind: r.kind, session: r.session })),
    );
    await mapLimit(list, ASK_FANOUT, (r, ord) => this.deliver(id, ord, from, body, r));
    audit("ask", { ask: id, from: from.name, asked: list.length, pick: input.pick ?? "none" }, question);
    return this.snapshot(id);
  }

  private async deliver(id: string, ord: number, from: Party, body: string, r: Recipient): Promise<void> {
    if (from.kind === "claude" && r.kind === "claude") return this.store.settle(id, ord, "skipped", "Claude sessions are asked with the built-in SendMessage");
    try {
      const routed = await this.deps.send({ msgId: `${id}:${ord}`, from, to: this.deps.targetOf(r.addr, r.name, r.session), body, urgency: "normal" });
      if (routed.status === "failed" || routed.status === "refused") return this.store.settle(id, ord, "failed", routed.error ?? `the message was ${routed.status}`);
      this.store.delivered(id, ord, routed.msgId, routed.decision.route);
      if (routed.decision.rule === NOT_FROM_DRIVER_RULE && routed.decision.driverName) this.store.driverNote(id, ord, routed.decision.driverName);
    } catch (err) {
      this.store.settle(id, ord, "failed", (err as Error).message);
    }
  }

  snapshot(id: string): AskSnapshot {
    const ask = this.store.get(id);
    if (!ask) throw new Error(`no ask ${id}`);
    const targets = this.store.targets(id);
    return {
      id,
      question: ask.question,
      status: ask.status,
      createdAt: ask.created_at,
      expiresAt: ask.expires_at,
      complete: targets.every((t) => t.state !== "asked"),
      targets: targets.map((t) => ({
        name: t.name,
        ref: refOf(t.addr),
        kind: t.kind,
        ...agentFieldOf(t.session),
        state: t.state,
        ...(t.note && { note: t.note }),
        ...((t.state === "asked" || t.state === "answered") && t.note ? { driver: t.note } : {}),
        ...(t.route && { route: t.route }),
        ...(t.msg_id && { msgId: t.msg_id }),
        ...(t.answer !== null && { answer: t.answer }),
        ...(t.answered_at !== null && { answeredAfterMs: t.answered_at - ask.created_at }),
      })),
    };
  }

  private asker(id: unknown, caller: Party): AskRow {
    const ask = typeof id === "string" ? this.store.get(id) : undefined;
    const mine = ask && (this.deps.holds(caller, ask.from_addr, ask.from_session) || (caller.kind === "cli" && caller.addr === null && ask.from_kind === "cli" && ask.from_name === caller.name));
    if (!ask || !mine) throw new Error(`no ask ${String(id)} made by you`);
    return ask;
  }

  async wait(askId: unknown, caller: Party, conn: Conn): Promise<AskSnapshot> {
    const ask = this.asker(askId, caller);
    for (;;) {
      const now = Date.now();
      const snap = this.snapshot(ask.id);
      if (snap.status === "closed" || snap.complete || now >= ask.expires_at || conn.isClosed()) {
        this.close(ask.id, now);
        return this.snapshot(ask.id);
      }
      await this.nap(ask.id, ask.expires_at - now, conn);
    }
  }

  private nap(id: string, ms: number, conn: Conn): Promise<void> {
    return new Promise<void>((resolve) => {
      const set = this.waiters.get(id) ?? new Set<() => void>();
      const done = (): void => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) this.waiters.delete(id);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      set.add(done);
      this.waiters.set(id, set);
      conn.onClose(done);
    });
  }

  private wake(id: string): void {
    for (const done of [...(this.waiters.get(id) ?? [])]) done();
  }

  private close(id: string, at: number): void {
    this.store.close(id, at);
    this.wake(id);
  }

  answer(caller: Party, askId: unknown, answer: unknown): { remaining: number } {
    const id = typeof askId === "string" ? askId : "";
    const ask = this.store.get(id);
    if (!ask) throw new Error(`no ask ${id || String(askId)}: the id is wrong or the ask was purged`);
    const targets = this.store.targets(id);
    const mine = targets.find((t) => this.deps.holds(caller, t.addr, t.session));
    if (!mine) throw new Error(`you were not asked in ${id}, so you cannot answer it`);
    if (!this.deps.mayReach(caller, { name: ask.from_name, addr: ask.from_addr, session: ask.from_session })) throw new SendError("not-allowed", `${caller.name} may not message ${ask.from_name}, so it cannot answer ${id}; the machine's owner sets that list with agentsocks gateway`);
    const text = typeof answer === "string" ? answer.replace(/\r\n/g, "\n").trim() : "";
    if (!text) throw new Error("answer is empty");
    if (text.length > ANSWER_MAX_CHARS) throw new Error(`answer is longer than ${ANSWER_MAX_CHARS} characters; put it in a file and answer with the path`);
    if (mine.state === "answered") throw new Error(`you already answered ${id}`);
    if (mine.state !== "asked") throw new Error(`ask ${id} never reached you (${mine.note ?? mine.state}), so there is nothing to answer`);
    const now = Date.now();
    if (ask.status === "closed" || now >= ask.expires_at) {
      throw new Error(`ask ${id} has closed (the asker is no longer waiting); send your answer with send_message instead`);
    }
    this.store.answer(id, mine.ord, text, now);
    audit("ask_answer", { ask: id, from: mine.name }, text);
    this.wake(id);
    return { remaining: targets.filter((t) => t.ord !== mine.ord && t.state === "asked").length };
  }

  pick(askId: unknown, caller: Party): Promise<PickResult> {
    const ask = this.asker(askId, caller);
    if (ask.pick !== "best") throw new Error(`ask ${ask.id} was not made with pick "best", so its replies are not sent to the model`);
    if (ask.pick_result) return Promise.resolve(JSON.parse(ask.pick_result) as PickResult);
    const running = this.picking.get(ask.id);
    if (running) return running;
    const run = this.runPick(ask).finally(() => this.picking.delete(ask.id));
    this.picking.set(ask.id, run);
    return run;
  }

  private async runPick(ask: AskRow): Promise<PickResult> {
    const replies = this.store
      .targets(ask.id)
      .filter((t) => t.state === "answered")
      .map((t) => ({ name: t.name, ref: refOf(t.addr), text: t.answer ?? "" }));
    const result = await pickBest(this.deps.classifier(), ask.question, replies);
    this.store.setPick(ask.id, result);
    audit("ask_pick", { ask: ask.id, status: result.status, backend: result.backend, remote: result.remote });
    return result;
  }

  closeAll(now: number): void {
    for (const id of this.store.open()) this.close(id, now);
  }

  maintain(now: number): void {
    for (const id of this.store.expired(now)) this.close(id, now);
    this.store.purge(now - ASK_KEEP_MS);
  }
}

function pickLine(pick: PickResult, tag: (item: { name: string; ref: string }) => string): string {
  if (pick.status !== "picked") return `Smart-routing pick: no pick was made: ${pick.note}.`;
  const odds = pick.probabilities ? ` Probabilities: ${pick.probabilities.map((p) => `${tag(p)} ${p.p}`).join(", ")}.` : "";
  return `Smart-routing pick (${pick.backend}, ${pick.remote ? "remote" : "on this machine"}): ${tag({ name: pick.choice!, ref: pick.choiceRef! })} answers best.${odds} This is the model's opinion, not a decision; every reply is shown above.`;
}

export function formatAsk({ ask, pick }: AskOutcome, visible?: readonly string[]): string {
  const tag = labeller(ask.targets);
  const who = (t: AskTargetView): string => `${tag(t)} (${kindLabel(t.kind, t.agent)})`;
  const delivered = ask.targets.filter((t) => t.state === "asked" || t.state === "answered");
  const answered = ask.targets.filter((t) => t.state === "answered");
  const seconds = Math.round((ask.expiresAt - ask.createdAt) / 1000);
  const lines = [`Ask ${ask.id}: ${delivered.length} ${delivered.length === 1 ? "session" : "sessions"} asked, ${answered.length} answered.`];
  for (const t of answered) lines.push("", `${who(t)} answered after ${Math.max(0, Math.round((t.answeredAfterMs ?? 0) / 1000))} s:`, t.answer ?? "");
  const waiting = ask.targets.filter((t) => t.state === "asked");
  if (waiting.length > 0) lines.push("");
  for (const t of waiting) lines.push(`No answer from ${who(t)} within ${seconds} s (their message was routed ${t.route ?? "unknown"}).${t.driver && (visible === undefined || visible.includes(t.driver)) ? ` ${driverInfoNote(t.name, t.driver)}` : ""} An answer sent any other way still reaches you as an ordinary message.`);
  const skipped = ask.targets.filter((t) => t.state === "skipped");
  if (skipped.length > 0) lines.push("", `Not asked: ${skipped.map(who).join(", ")}: you are a Claude session, so ask Claude sessions with your built-in SendMessage.`);
  for (const t of ask.targets.filter((x) => x.state === "failed")) lines.push(`Not delivered to ${who(t)}: ${t.note ?? "unknown error"}.`);
  if (pick) lines.push("", pickLine(pick, tag));
  return lines.join("\n");
}
