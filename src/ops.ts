import { randomUUID } from "node:crypto";
import { brokerCall, outcomeUnknown } from "./client.ts";
import { encodeAddress } from "./envelope.ts";
import { listPeers, RESOLVABLE, type Me } from "./peers.ts";
import { nativeSendTo, partyOf, resolveTarget, targetOf } from "./send.ts";
import type { PeerStatus, MessageRecord, DestinationStats } from "./status.ts";
import type { Risk, TaskStatus, TaskUpdate } from "./tasks.ts";
import type { RouteSendResult } from "./routing.ts";
import type { TaskRow } from "./store.ts";

export interface NewTask {
  to: string;
  title: string;
  details: string;
  acceptance?: string;
  risk?: Risk;
  externalRef?: string;
  onBehalfOf?: string;
  expiresInMinutes?: number;
}

export async function createTask(me: Me, input: NewTask): Promise<{ task: TaskRow; delivery?: RouteSendResult; toName: string; sendTo: string }> {
  const known = await listPeers(RESOLVABLE);
  const target = await resolveTarget(known, input.to, me);
  const requestId = randomUUID();
  const out = await brokerCall<{ task: TaskRow; delivery?: RouteSendResult }>(
    "task_create",
    {
      from: partyOf(me),
      to: targetOf(target),
      title: input.title,
      body: input.details,
      ...(input.acceptance && { acceptance: input.acceptance }),
      ...(input.risk && { risk: input.risk }),
      ...(input.externalRef && { externalRef: input.externalRef }),
      ...(input.onBehalfOf && { onBehalfOf: input.onBehalfOf }),
      ...(input.expiresInMinutes && { expiresInMinutes: input.expiresInMinutes }),
      requestId,
    },
    { autoStart: true, timeoutMs: 15_000 },
  ).catch((err) => {
    if (outcomeUnknown(err)) throw new Error("The broker did not answer in time. The task may already exist; check with tasks before creating it again.");
    throw err;
  });
  return { ...out, toName: target.name, sendTo: nativeSendTo(target, known) };
}

export function changeTask(me: Me, taskId: string, status: TaskStatus, result?: string, evidence?: string): Promise<TaskUpdate> {
  return brokerCall<TaskUpdate>("task_update", { taskId, status, actor: partyOf(me), ...(result && { result }), ...(evidence && { evidence }) }, { timeoutMs: 15_000 }).catch((err) => {
    if (outcomeUnknown(err)) throw new Error(`The broker did not answer in time. The update to ${taskId} may already be applied; read the task with list_tasks before trying again.`);
    throw err;
  });
}

export type TaskScope = "assigned_to_me" | "created_by_me" | "all";

export function listTasks(me: Me, scope: TaskScope = "all", includeFinished = false): Promise<TaskRow[]> {
  const party = me.socketPath ? encodeAddress(me.socketPath) : undefined;
  return brokerCall("task_list", {
    ...(party && { party }),
    ...(me.session && { session: me.session }),
    role: scope === "assigned_to_me" ? "assignee" : scope === "created_by_me" ? "creator" : "any",
    status: includeFinished ? "all" : "active",
  });
}

export function getTask(me: Me, taskId: string): Promise<TaskRow> {
  return brokerCall("task_get", { taskId, party: partyOf(me) });
}

export function messageStatus(me: Me, msgId: string): Promise<MessageRecord> {
  return brokerCall("message_status", { msgId, party: partyOf(me) });
}

export async function peerStatus(me: Me, peer: string): Promise<PeerStatus> {
  const target = await resolveTarget(undefined, peer, me, { allowSelf: true, adopt: false });
  return brokerCall("peer_status", { to: targetOf(target) });
}

export function stats(to?: string): Promise<{ days: number; destinations: DestinationStats[] }> {
  return brokerCall("stats", to ? { to } : {});
}
