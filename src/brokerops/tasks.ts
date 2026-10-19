import { SendError } from "../ccsocks.ts";
import type { Broker } from "../broker.ts";
import { SESSION_ID, validId } from "../limits.ts";
import { killSwitchOn } from "../paths.ts";
import { parseParty, parseTarget } from "../routing.ts";
import { ACTIVE_STATUSES, type Risk, type TaskStatus } from "../tasks.ts";
import type { OpTable, OpRequest } from "./types.ts";

async function taskCreate(broker: Broker, req: OpRequest) {
  if (killSwitchOn()) throw new SendError("off", "agentsocks is switched off on this machine (kill switch)");
  const risk: Risk = req.risk === "high" || req.risk === "medium" ? req.risk : "low";
  return broker.tasks.create({
    from: parseParty(req.from),
    to: parseTarget(req.to),
    title: String(req.title ?? ""),
    body: String(req.body ?? ""),
    risk,
    ...(typeof req.acceptance === "string" && { acceptance: req.acceptance }),
    ...(typeof req.externalRef === "string" && { externalRef: req.externalRef }),
    ...(typeof req.onBehalfOf === "string" && { onBehalfOf: req.onBehalfOf }),
    ...(typeof req.expiresInMinutes === "number" && { expiresInMinutes: req.expiresInMinutes }),
    ...(validId(req.requestId) && { requestId: validId(req.requestId)! }),
  });
}

async function taskUpdate(broker: Broker, req: OpRequest) {
  if (killSwitchOn()) throw new SendError("off", "agentsocks is switched off on this machine (kill switch)");
  const status = String(req.status ?? "") as TaskStatus;
  return broker.tasks.update({
    taskId: String(req.taskId ?? ""),
    status,
    actor: parseParty(req.actor),
    ...(typeof req.result === "string" && { result: req.result }),
    ...(typeof req.evidence === "string" && { evidence: req.evidence }),
  });
}

function taskList(broker: Broker, req: OpRequest) {
  const party = broker.canon(typeof req.party === "string" ? req.party : null) ?? undefined;
  const session = typeof req.session === "string" && SESSION_ID.test(req.session) ? req.session : undefined;
  if (!party && !session) throw new Error("tasks are listed for a session: run this from inside a Claude Code or Codex session");
  const role = req.role === "assignee" || req.role === "creator" ? req.role : "any";
  const status = typeof req.status === "string" ? req.status : "active";
  const statuses = status === "all" ? undefined : status === "active" ? [...ACTIVE_STATUSES] : [status as TaskStatus];
  return broker.store.listTasks({ ...(party && { party }), ...(session && { session }), role, ...(statuses && { statuses }), limit: typeof req.limit === "number" ? req.limit : 50 });
}

export const taskOps: OpTable = {
  task_create: async (broker, req) => ({ result: await taskCreate(broker, req) }),
  task_update: async (broker, req) => ({ result: await taskUpdate(broker, req) }),
  task_list: async (broker, req) => ({ result: taskList(broker, req) }),
  task_get: async (broker, req) => {
    const caller = parseParty(req.party, "party");
    const task = typeof req.taskId === "string" ? broker.store.getTask(req.taskId) : undefined;
    if (!task || !(broker.holds(caller, task.from_addr, task.from_session) || broker.holds(caller, task.to_addr, task.to_session))) throw new Error(`no task ${String(req.taskId)} created by or assigned to you`);
    return { result: task };
  },
};
