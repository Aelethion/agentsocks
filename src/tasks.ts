import { randomBytes } from "node:crypto";
import { decodeAddress, encodeAddress } from "./envelope.ts";
import { canonicalPath, threadSocketPath } from "./paths.ts";
import { listClaudeSessions } from "./claude.ts";
import { driverInfoNote, type RouteSendResult, type Party, type Target } from "./routing.ts";
import { gatewayState, mayMessage, parseAllow } from "./gateway/state.ts";
import { isDriver, makeDriverScope, type DriverScope, type Urgency } from "./router.ts";
import { squash } from "./limits.ts";
import type { Store, TaskRow } from "./store.ts";

export type TaskStatus = "open" | "accepted" | "in_progress" | "done" | "failed" | "cancelled" | "expired";
export type Risk = "low" | "medium" | "high";
export type TaskRole = "assignee" | "creator" | "system";

export const ACTIVE_STATUSES: readonly TaskStatus[] = ["open", "accepted", "in_progress"];
export const DEFAULT_TASK_TTL_MS = 24 * 3_600_000;
export const MAX_TASK_TTL_MS = 7 * 24 * 3_600_000;
export const STALE_TASK_MS = 2 * 3_600_000;
export const UNACCEPTED_TASK_MS = 30 * 60_000;

interface Move {
  from: readonly TaskStatus[];
  by: TaskRole;
}

export const MOVES: Record<Exclude<TaskStatus, "open">, Move> = {
  accepted: { from: ["open"], by: "assignee" },
  in_progress: { from: ["open", "accepted", "in_progress"], by: "assignee" },
  done: { from: [...ACTIVE_STATUSES, "expired"], by: "assignee" },
  failed: { from: [...ACTIVE_STATUSES, "expired"], by: "assignee" },
  cancelled: { from: ACTIVE_STATUSES, by: "creator" },
  expired: { from: ACTIVE_STATUSES, by: "system" },
};

export function checkMove(from: TaskStatus, to: TaskStatus, role: TaskRole | undefined): string | undefined {
  if (to === "open") return "a task cannot be reopened";
  if (!Object.hasOwn(MOVES, to)) return `${String(to)} is not a task status`;
  const move = MOVES[to];
  if (!move.from.includes(from)) return `a task that is ${from.replace("_", " ")} cannot become ${to.replace("_", " ")}`;
  if (role !== move.by) return move.by === "creator" ? "only the creator can cancel a task" : move.by === "assignee" ? "only the assignee can update a task" : "only agentsocks expires a task";
  return undefined;
}

const LIMITS = { title: 120, body: 16_000, acceptance: 4_000, result: 8_000, evidence: 8_000, externalRef: 200, onBehalfOf: 120 };

export interface TaskInput {
  from: Party;
  to: Target;
  title: string;
  body: string;
  acceptance?: string;
  risk?: Risk;
  externalRef?: string;
  onBehalfOf?: string;
  expiresInMinutes?: number;
  requestId?: string;
}

export interface TaskChange {
  taskId: string;
  status: TaskStatus;
  result?: string;
  evidence?: string;
  actor: Party;
}

export type TaskNotice = { to: "creator" | "assignee" } & (
  | { outcome: "sent" }
  | { outcome: "batched"; receiver: Target["kind"] }
  | { outcome: "native"; name: string; text: string }
  | { outcome: "not-sent"; detail: string }
);

export interface TaskUpdate {
  task: TaskRow;
  notified: boolean;
  notice: TaskNotice;
}

const TERMINAL: readonly TaskStatus[] = ["done", "failed", "cancelled", "expired"];

export interface TaskDeps {
  store: Store;
  send(request: Record<string, unknown>): Promise<RouteSendResult>;
  canon(addr: string | null | undefined): string | null;
  targetOf(addr: string, name: string, session: string | null): Target;
  recorded(taskId: string): RouteSendResult | undefined;
  verify(target: Target): void;
}

const bothClaude = (from: Party["kind"], to: Target["kind"]): boolean => from === "claude" && to === "claude";

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");

const liveDriverName = (store: Store, driven: { driver_addr: string | null; driver_sid: string | null }, snapshot: string | null): string | null => {
  const sid = driven.driver_sid ?? null;
  if (sid !== null && sid.startsWith("session:")) {
    const live = listClaudeSessions().find((s) => s.sessionId === sid.slice("session:".length));
    if (live) return live.name;
  } else if (sid !== null && sid.startsWith("thread:")) {
    const live = store.getThread(sid.slice("thread:".length));
    if (live) return live.name;
  }
  const path = driven.driver_addr ? decodeAddress(driven.driver_addr) : null;
  if (!path) return snapshot;
  const want = canonicalPath(path);
  return store.listThreads().find((t) => canonicalPath(threadSocketPath(t.thread_id)) === want)?.name ?? listClaudeSessions().find((s) => canonicalPath(s.socketPath) === want)?.name ?? snapshot;
};

const driverScopeOf = (store: Store, canon: TaskDeps["canon"]): DriverScope =>
  makeDriverScope({
    canon,
    threadIdForAddr: (c) => store.listThreads(true).find((t) => canon(encodeAddress(threadSocketPath(t.thread_id))) === c)?.thread_id,
    claudeSessionForAddr: (c) => {
      const path = decodeAddress(c);
      const want = path ? canonicalPath(path) : null;
      return want ? listClaudeSessions().find((s) => canonicalPath(s.socketPath) === want)?.sessionId : undefined;
    },
    knownSessionForAddr: (c) => {
      const row: unknown = store.db.prepare("SELECT from_session AS s FROM outbox WHERE from_addr = ? AND from_session IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(c);
      if (row && typeof row === "object" && "s" in row && typeof row.s === "string") return row.s;
      return undefined;
    },
  });

const drivenThreadOf = (store: Store, canon: TaskDeps["canon"], assignee: string, threadId: string | undefined) => {
  const path = decodeAddress(canon(assignee) ?? assignee);
  const wanted = path ? canonicalPath(path) : undefined;
  return (wanted ? store.listThreads().find((t) => canonicalPath(threadSocketPath(t.thread_id)) === wanted) : undefined) ?? (threadId ? store.getThread(threadId) : undefined);
};

export function taskAssignment(t: TaskRow, requester: string): string {
  const lines = [`[agentsocks task ${t.id}] ${t.title}`, "", t.body];
  if (t.acceptance) lines.push("", `Acceptance criteria: ${t.acceptance}`);
  lines.push("", `Risk: ${t.risk}. Expires: ${new Date(t.expires_at).toISOString()}.`);
  lines.push(`Requested by @${requester}.${t.on_behalf_of ? ` On behalf of (as stated by the sender): ${t.on_behalf_of}.` : ""}${t.external_ref ? ` Reference: ${t.external_ref}.` : ""}`);
  lines.push(
    "",
    `To update this task, call the agentsocks update_task tool with task_id "${t.id}" and status accepted, in_progress, done or failed. Put the outcome in result and the proof in evidence (test output, commit hashes, file paths). The creator is told about each change.`,
  );
  return lines.join("\n");
}

export function taskNotice(t: TaskRow, by: string): string {
  const lines = [`[agentsocks task ${t.id}] ${t.title}: ${t.status.replace("_", " ")}${by ? ` (by @${by})` : ""}`];
  if (t.result) lines.push("", `Result: ${t.result}`);
  if (t.evidence) lines.push("", `Evidence: ${t.evidence}`);
  return lines.join("\n");
}

export function noticeUrgency(status: TaskStatus): Urgency {
  return status === "done" || status === "failed" || status === "cancelled" ? "normal" : "fyi";
}

export function taskNoticeLine(t: TaskRow, by: string): string {
  const parts = [`[agentsocks task ${t.id}] ${t.title}: ${t.status.replace("_", " ")}${by ? ` (by @${by})` : ""}.`];
  if (t.result) parts.push(`Result: ${squash(t.result, 160)}`);
  if (t.evidence) parts.push(`Evidence: ${squash(t.evidence, 160)}`);
  return parts.join(" ");
}

export function renderTask(t: TaskRow, now: number): string {
  const due = t.expires_at - now;
  const when = ACTIVE_STATUSES.includes(t.status) ? (due > 0 ? `expires in ${Math.max(1, Math.round(due / 60_000))} min` : "past its expiry") : `closed ${new Date(t.updated_at).toISOString()}`;
  const lines = [`${t.id} [${t.status.replace("_", " ")}] ${t.title}`, `  from @${t.from_name} to @${t.to_name}, risk ${t.risk}, ${when}`];
  if (t.acceptance) lines.push(`  acceptance: ${squash(t.acceptance, 300)}`);
  if (t.result) lines.push(`  result: ${squash(t.result, 300)}`);
  if (t.evidence) lines.push(`  evidence: ${squash(t.evidence, 300)}`);
  return lines.join("\n");
}

export class TaskService {
  private readonly deps: TaskDeps;
  private readonly creating = new Map<string, Promise<{ task: TaskRow; delivery?: RouteSendResult }>>();

  constructor(deps: TaskDeps) {
    this.deps = deps;
  }

  create(input: TaskInput, now: number = Date.now()): Promise<{ task: TaskRow; delivery?: RouteSendResult }> {
    const { requestId } = input;
    if (!requestId) return this.createOnce(input, now);
    const running = this.creating.get(requestId);
    if (running) return running;
    const existing = this.deps.store.getTaskByRequest(requestId);
    const delivery = existing && !bothClaude(input.from.kind, input.to.kind) ? this.deps.recorded(existing.id) : undefined;
    if (existing && (delivery || bothClaude(input.from.kind, input.to.kind))) {
      if (existing.from_addr !== this.deps.canon(input.from.addr)) return Promise.reject(new Error(`request id ${requestId} was already used for another task`));
      return Promise.resolve({ task: existing, ...(delivery && { delivery }) });
    }
    const run = this.createOnce(input, now).finally(() => this.creating.delete(requestId));
    this.creating.set(requestId, run);
    return run;
  }

  private async createOnce(input: TaskInput, now: number): Promise<{ task: TaskRow; delivery?: RouteSendResult }> {
    const { store, canon } = this.deps;
    const creator = canon(input.from.addr);
    if (!creator) throw new Error("tasks need a session that can receive replies; this caller has no inbox address");
    const title = squash(input.title, LIMITS.title);
    const body = text(input.body, LIMITS.body);
    if (!title) throw new Error("a task needs a title");
    if (!body) throw new Error("a task needs details in body");
    const assignee = canon(input.to.addr);
    if (!assignee) throw new Error("the assignee address is not valid");
    if (assignee === creator) throw new Error("you cannot assign a task to yourself");
    const driven = drivenThreadOf(store, canon, assignee, input.to.threadId);
    const scope = driverScopeOf(store, canon);
    if (driven?.driver_addr && !isDriver(scope, { addr: driven.driver_addr, sid: driven.driver_sid ?? null }, creator, input.from.session)) {
      const peer = input.from.session ? gatewayState(store).peerByThread(input.from.session) : undefined;
      const allow = peer && !peer.disabled ? parseAllow(peer.may_message) : null;
      const live = liveDriverName(store, driven, driven.driver_name);
      throw new Error(driverInfoNote(driven.name, allow === null || mayMessage(allow, { name: live ?? "" }) ? (live ?? "their driver") : null));
    }
    const ttl = Math.min(Math.max(Math.round((input.expiresInMinutes ?? DEFAULT_TASK_TTL_MS / 60_000) * 60_000), 60_000), MAX_TASK_TTL_MS);
    let id: string;
    do id = `T-${randomBytes(3).toString("hex")}`;
    while (store.getTask(id));
    const task: TaskRow = {
      id,
      from_addr: creator,
      from_name: input.from.name,
      to_addr: assignee,
      to_name: input.to.name,
      to_kind: input.to.kind,
      title,
      body,
      acceptance: text(input.acceptance, LIMITS.acceptance) || null,
      risk: input.risk ?? "low",
      external_ref: squash(input.externalRef, LIMITS.externalRef) || null,
      on_behalf_of: squash(input.onBehalfOf, LIMITS.onBehalfOf) || null,
      status: "open",
      result: null,
      evidence: null,
      from_session: input.from.session,
      to_session: input.to.sessionId ?? input.to.threadId ?? null,
      request_id: input.requestId ?? null,
      created_at: now,
      updated_at: now,
      expires_at: now + ttl,
    };
    store.insertTask(task);
    if (bothClaude(input.from.kind, input.to.kind)) {
      try {
        this.deps.verify(input.to);
      } catch (err) {
        store.deleteTask(id);
        throw err;
      }
      return { task };
    }
    let delivery: RouteSendResult;
    try {
      delivery = await this.deps.send({ from: input.from, to: input.to, body: taskAssignment(task, input.from.name), urgency: task.risk === "high" ? "urgent" : "normal", taskId: id });
    } catch (err) {
      store.deleteTask(id);
      throw err;
    }
    if (delivery.status === "failed" || delivery.status === "refused") {
      store.deleteTask(id);
      throw new Error(`the task was not delivered: ${delivery.error ?? delivery.status}`);
    }
    return { task, delivery };
  }

  async update(change: TaskChange, now: number = Date.now()): Promise<TaskUpdate> {
    const { store, canon } = this.deps;
    const task = store.getTask(change.taskId);
    if (!task) throw new Error(`no task ${change.taskId}`);
    const actor = canon(change.actor.addr);
    const session = change.actor.session;
    const is = (addr: string, held: string | null) => (actor !== null && actor === addr) || (!!session && session === held);
    const role: TaskRole | undefined = is(task.to_addr, task.to_session) ? "assignee" : is(task.from_addr, task.from_session) ? "creator" : undefined;
    if (!role) throw new Error("only the assignee or the creator of a task can update it");
    const moved = await this.move(task, change.status, role, change.actor, { result: text(change.result, LIMITS.result) || undefined, evidence: text(change.evidence, LIMITS.evidence) || undefined }, now);
    if (actor && actor !== (role === "assignee" ? task.to_addr : task.from_addr)) store.rebindTask(task.id, role === "assignee" ? "to" : "from", actor);
    return moved;
  }

  async expireDue(now: number = Date.now()): Promise<number> {
    const system: Party = { kind: "cli", name: "agentsocks", addr: null, session: null, mode: null };
    let expired = 0;
    for (const task of this.deps.store.dueTasks(now)) {
      try {
        await this.move(task, "expired", "system", system, {}, now);
        expired++;
      } catch {}
    }
    return expired;
  }

  private async move(
    task: TaskRow,
    to: TaskStatus,
    role: TaskRole,
    actor: Party,
    fields: { result?: string | undefined; evidence?: string | undefined },
    now: number,
  ): Promise<TaskUpdate> {
    const { store } = this.deps;
    const refusal = checkMove(task.status, to, role);
    if (refusal) throw new Error(refusal);
    const changed = store.moveTask(task.id, [task.status], to, { ...(fields.result !== undefined && { result: fields.result }), ...(fields.evidence !== undefined && { evidence: fields.evidence }) }, now);
    if (!changed) throw new Error(`task ${task.id} changed while it was being updated; read it again`);
    const updated = store.getTask(task.id)!;
    if (TERMINAL.includes(to)) store.supersedeHeldForTask(task.id, `superseded: the task is now ${to.replace("_", " ")}`);
    const toCreator = role !== "creator";
    const recipient = toCreator
      ? { addr: updated.from_addr, name: updated.from_name, session: updated.from_session }
      : { addr: updated.to_addr, name: updated.to_name, session: updated.to_session };
    const side = toCreator ? "creator" : "assignee";
    let notice: TaskNotice;
    const by = role === "system" ? "" : actor.name;
    if (bothClaude(this.deps.targetOf(updated.from_addr, updated.from_name, updated.from_session).kind, updated.to_kind)) {
      notice = { to: side, outcome: "native", name: recipient.name, text: taskNoticeLine(updated, by) };
      return { task: updated, notified: false, notice };
    }
    const target = this.deps.targetOf(recipient.addr, recipient.name, recipient.session);
    try {
      const sent = await this.deps.send({
        from: actor,
        to: target,
        body: taskNotice(updated, by),
        urgency: noticeUrgency(to),
        taskId: task.id,
      });
      notice =
        sent.status === "failed" || sent.status === "refused"
          ? { to: side, outcome: "not-sent", detail: sent.error ?? sent.status }
          : sent.status === "merged"
            ? { to: side, outcome: "not-sent", detail: sent.decision.reason }
            : sent.status === "held"
              ? { to: side, outcome: "batched", receiver: sent.to.kind }
              : { to: side, outcome: "sent" };
    } catch (err) {
      notice = { to: side, outcome: "not-sent", detail: (err as Error).message };
    }
    return { task: updated, notified: notice.outcome !== "not-sent", notice };
  }
}
