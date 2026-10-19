import { z } from "zod";
import { changeTask, createTask, listTasks } from "../ops.ts";
import { formatTasks } from "../render.ts";
import { digestWait } from "../routing.ts";
import { renderTask, taskAssignment, type TaskNotice } from "../tasks.ts";
import { fail, peerText, text } from "./result.ts";
import { defineTool } from "./types.ts";

function describeNotice(n: TaskNotice): string {
  if (n.outcome === "sent") return `The ${n.to} was told.`;
  if (n.outcome === "batched") return `The ${n.to}'s notice is batched: they see it ${digestWait(n.receiver)}.`;
  if (n.outcome === "native") return `Updated. The ${n.to} (@${n.name}) was not notified automatically, because you are both Claude sessions. If it matters, send this to them with your built-in SendMessage: ${n.text}`;
  return `Updated, but the ${n.to} was not told: ${n.detail}.`;
}

export const taskTools = [
  defineTool({
    name: "send_task",
    title: "Hand another session a tracked task",
    annotations: { destructiveHint: false, openWorldHint: false },
    description:
      "Give another agent session a task you will check on. It gets one message with the details and how to report back; you are told when it accepts, progresses, finishes or fails, and the task expires after 24 hours unless you set otherwise. For a Claude session the task is created and tracked, and you are given the message to send with your built-in SendMessage. Say what done looks like in acceptance_criteria. Use risk high only for work that must not wait.",
    inputSchema: {
      to: z.string().min(1).describe("Assignee: session name, ref, or uds: address"),
      title: z.string().min(1).max(120).describe("One line saying what to do"),
      details: z.string().min(1).describe("Everything the assignee needs: context, file paths, constraints"),
      acceptance_criteria: z.string().optional().describe("How you will judge it done, for example which test must pass"),
      risk: z.enum(["low", "medium", "high"]).default("low").describe("high is delivered as urgent"),
      external_ref: z.string().max(200).optional().describe("Ticket or PR reference"),
      on_behalf_of: z.string().max(120).optional().describe("The person this is for, if any"),
      expires_in_minutes: z.number().int().min(1).max(10_080).optional().describe("Default 1440 (24 hours)"),
    },
    host: "both",
    handler: async (a, ctx) => {
      try {
        const me = await ctx.identify();
        const r = await createTask(me, {
          to: a.to,
          title: a.title,
          details: a.details,
          risk: a.risk,
          ...(a.acceptance_criteria && { acceptance: a.acceptance_criteria }),
          ...(a.external_ref && { externalRef: a.external_ref }),
          ...(a.on_behalf_of && { onBehalfOf: a.on_behalf_of }),
          ...(a.expires_in_minutes && { expiresInMinutes: a.expires_in_minutes }),
        });
        if (!r.delivery) return text(`Task ${r.task.id} created. Send it to ${r.sendTo} with your built-in SendMessage (it carries your permission mode); paste this:\n\n${taskAssignment(r.task, me.name)}`);
        return peerText(r.delivery.status === "held" ? `Task ${r.task.id} created and queued for @${r.toName}; they see it ${digestWait(r.delivery.to.kind)}. You are told each time it moves.` : `Task ${r.task.id} created and sent to @${r.toName}. You are told each time it moves.`);
      } catch (err) {
        return fail(`Task not created: ${(err as Error).message}`);
      }
    },
  }),
  defineTool({
    name: "update_task",
    title: "Update a task",
    annotations: { openWorldHint: false },
    description:
      "Report progress on a task. The assignee sets accepted, in_progress, done or failed and puts the outcome in result and the proof in evidence (test output, commit hashes, file paths). Only the creator can set cancelled. The creator is told about every change.",
    inputSchema: {
      task_id: z.string().regex(/^T-[0-9a-f]{6}$/).describe("Task id such as T-1a2b3c"),
      status: z.enum(["accepted", "in_progress", "done", "failed", "cancelled"]).describe("The new state. The assignee sets accepted, in_progress, done or failed; only the creator sets cancelled"),
      result: z.string().optional().describe("What happened, in a few sentences"),
      evidence: z.string().optional().describe("Proof: test output, commit hashes, file paths"),
    },
    host: "both",
    handler: async ({ task_id, status, result, evidence }, ctx) => {
      try {
        const me = await ctx.identify();
        const r = await changeTask(me, task_id, status, result, evidence);
        return peerText(`${renderTask(r.task, Date.now())}\n${describeNotice(r.notice)}`);
      } catch (err) {
        return fail(`Not updated: ${(err as Error).message}`);
      }
    },
  }),
  defineTool({
    name: "list_tasks",
    title: "List tasks",
    description: "List tasks assigned to you or created by you. Active ones by default.",
    inputSchema: {
      show: z.enum(["all", "assigned_to_me", "created_by_me"]).default("all").describe("Which tasks: those you were assigned, those you created, or both"),
      include_finished: z.boolean().default(false).describe("Also show done, failed, cancelled and expired tasks"),
    },
    host: "both",
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ show, include_finished }, ctx) => {
      try {
        const me = await ctx.identify();
        return peerText(formatTasks(await listTasks(me, show, include_finished)));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  }),
];
