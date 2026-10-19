import { randomBytes } from "node:crypto";
import { kindLabel } from "../../agents/types.ts";
import { audit } from "../../audit.ts";
import { SendError } from "../../ccsocks.ts";
import { cleanText, squash } from "../../limits.ts";
import { changeTask, listTasks } from "../../ops.ts";
import { sendMessage } from "../../send.ts";
import { ACTIVE_STATUSES, type TaskStatus } from "../../tasks.ts";
import type { MessageRow, TaskRow } from "../../store.ts";
import { meOf, visiblePeers } from "../gtools.ts";
import { HttpError, readJson, sendJson, sendText } from "../http.ts";
import { acceptableEndpoint, dropSubscription, saveSubscription, subscriptionsOf, vapidOf } from "../push.ts";
import { callerOf, type RequestContext, type Route } from "../routes.ts";
import { appHtml } from "./page.ts";
import { iconPng } from "./icon.ts";
import { manifest } from "./manifest.ts";
import { SERVICE_WORKER } from "./worker.ts";

const MAX_JSON = 128 * 1024;
const MAX_WAIT_SECONDS = 25;
const READ_CHARS = 32_000;

function csp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

async function html(ctx: RequestContext): Promise<void> {
  const nonce = randomBytes(16).toString("base64");
  sendText(ctx.res, 200, "text/html; charset=utf-8", appHtml(nonce), { "Content-Security-Policy": csp(nonce), "X-Frame-Options": "DENY" });
}

async function webManifest(ctx: RequestContext): Promise<void> {
  sendText(ctx.res, 200, "application/manifest+json; charset=utf-8", JSON.stringify(manifest()));
}

async function worker(ctx: RequestContext): Promise<void> {
  sendText(ctx.res, 200, "text/javascript; charset=utf-8", SERVICE_WORKER, { "Service-Worker-Allowed": "/app/" });
}

async function icon(ctx: RequestContext): Promise<void> {
  sendText(ctx.res, 200, "image/png", iconPng(), { "Cache-Control": "max-age=86400" });
}

interface AppMessage {
  id: string;
  kind: "message" | "receipt";
  from: string;
  fromKind: string | null;
  body: string;
  at: number;
  route?: string;
}

function receiptText(body: string): string {
  try {
    const r = JSON.parse(body) as { status?: unknown; orig?: unknown; reason?: unknown };
    const reason = typeof r.reason === "string" && r.reason ? `: ${squash(r.reason, 160)}` : "";
    return `your message ${squash(String(r.orig ?? "?"), 40)} was ${squash(String(r.status ?? "unknown"), 24)}${reason}`;
  } catch {
    return "a delivery notice arrived";
  }
}

function present(m: MessageRow): AppMessage {
  return m.kind === "receipt"
    ? { id: m.msg_id, kind: "receipt", from: "agentsocks", fromKind: null, body: receiptText(m.body), at: m.received_at }
    : { id: m.msg_id, kind: "message", from: m.from_name ?? "unknown", fromKind: m.from_kind, body: m.body, at: m.received_at, route: m.route };
}

async function state(ctx: RequestContext): Promise<void> {
  const caller = callerOf(ctx);
  const store = ctx.broker.store;
  const peers = await visiblePeers(ctx.broker, caller);
  const active = store.listTasks({ session: caller.peer.thread_id, statuses: [...ACTIVE_STATUSES], limit: 100 });
  const vapid = vapidOf(ctx.gateway.state);
  sendJson(ctx.res, 200, {
    me: { name: caller.peer.name, login: caller.peer.login ?? "", node: caller.peer.machine ?? "" },
    peers: peers.map((p) => ({ name: p.name, ref: p.ref, kind: kindLabel(p.kind, p.agent), ...(p.via && { via: p.via }), ...(p.machine && { machine: p.machine }), status: p.status ?? "running" })),
    unread: store.queuedCount(caller.peer.thread_id, false),
    tasks: active.length,
    push: { key: vapid.publicKey, subscribed: subscriptionsOf(ctx.gateway.state, caller.peer.id).length > 0 },
  });
}

async function inbox(ctx: RequestContext): Promise<void> {
  const caller = callerOf(ctx);
  const thread = caller.peer.thread_id;
  const asked = Number(ctx.url.searchParams.get("wait") ?? 0);
  const seconds = Number.isFinite(asked) ? Math.max(0, Math.min(Math.trunc(asked), MAX_WAIT_SECONDS)) : 0;
  const { req, res, broker } = ctx;
  broker.releaseDigests(thread);
  await broker.waitForUnread(thread, seconds * 1000, { isClosed: () => res.destroyed || req.socket.destroyed, onClose: (fn) => void res.once("close", fn) });
  broker.releaseDigests(thread);
  const { messages, remaining } = broker.store.peek(thread, READ_CHARS);
  if (messages.length > 0) {
    ctx.afterResponse(() => {
      const now = Date.now();
      broker.store.markSurfaced(messages.map((m) => m.id), now);
      broker.store.markShown(messages.filter((m) => m.kind === "message").map((m) => m.msg_id), thread, now);
      audit("surface", { thread, ids: messages.map((m) => m.id), via: "app" });
    });
  }
  sendJson(res, 200, { messages: messages.map(present), remaining });
}

async function history(ctx: RequestContext): Promise<void> {
  const caller = callerOf(ctx);
  const asked = Number(ctx.url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(asked) ? Math.max(1, Math.min(Math.trunc(asked), 200)) : 50;
  const rows = ctx.broker.store.db
    .prepare("SELECT * FROM messages WHERE to_thread = ? AND kind = 'message' AND state = 'surfaced' ORDER BY surfaced_at DESC, received_at DESC LIMIT ?")
    .all(caller.peer.thread_id, limit) as unknown as MessageRow[];
  sendJson(ctx.res, 200, { messages: rows.reverse().map(present) });
}

const URGENCIES = new Set(["urgent", "normal", "fyi"]);

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "send a JSON object");
  return value as Record<string, unknown>;
};

async function send(ctx: RequestContext): Promise<void> {
  const caller = callerOf(ctx);
  const body = object(await readJson(ctx.req, MAX_JSON));
  const to = typeof body.to === "string" ? body.to : "";
  const message = typeof body.message === "string" ? body.message : "";
  const urgency = typeof body.urgency === "string" && URGENCIES.has(body.urgency) ? (body.urgency as "urgent" | "normal" | "fyi") : "normal";
  if (!to.trim() || !message.trim()) throw new HttpError(400, "give a recipient and a message");
  if (/^\s*@?uds:/i.test(to)) throw new HttpError(400, "send to a name from the peer list");
  try {
    const r = await sendMessage(meOf(ctx.broker, caller), to, message, await visiblePeers(ctx.broker, caller), { urgency, adopt: false, brokerOnly: true });
    sendJson(ctx.res, 200, { ok: true, msgId: r.msgId, to: { name: r.to.name, kind: kindLabel(r.to.kind, r.to.agent) }, note: r.note });
  } catch (err) {
    const status = err instanceof SendError && err.code === "rate-limited" ? 429 : 400;
    sendJson(ctx.res, status, { error: (err as Error).message });
  }
}

const presentTask = (t: TaskRow, thread: string) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  from: t.from_name,
  to: t.to_name,
  mine: t.to_session === thread ? "assignee" : "creator",
  risk: t.risk,
  expiresAt: t.expires_at,
  body: t.body,
  acceptance: t.acceptance,
  result: t.result,
  evidence: t.evidence,
});

async function tasks(ctx: RequestContext): Promise<void> {
  const caller = callerOf(ctx);
  const rows = await listTasks(meOf(ctx.broker, caller), "all", true);
  sendJson(ctx.res, 200, { tasks: rows.slice(0, 100).map((t) => presentTask(t, caller.peer.thread_id)) });
}

const TASK_MOVES = new Set(["accepted", "in_progress", "done", "failed", "cancelled"]);

async function updateTask(ctx: RequestContext): Promise<void> {
  const caller = callerOf(ctx);
  const body = object(await readJson(ctx.req, MAX_JSON));
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  const status = typeof body.status === "string" ? body.status : "";
  if (!/^T-[0-9a-f]{6}$/.test(taskId) || !TASK_MOVES.has(status)) throw new HttpError(400, "give a task id and one of accepted, in_progress, done, failed, cancelled");
  try {
    await changeTask(meOf(ctx.broker, caller), taskId, status as TaskStatus, typeof body.result === "string" ? body.result : undefined, typeof body.evidence === "string" ? body.evidence : undefined);
    sendJson(ctx.res, 200, { ok: true });
  } catch (err) {
    sendJson(ctx.res, 400, { error: (err as Error).message });
  }
}

async function subscribe(ctx: RequestContext): Promise<void> {
  const caller = callerOf(ctx);
  const body = object(await readJson(ctx.req, MAX_JSON));
  const keys = object(body.keys);
  const endpoint = acceptableEndpoint(body.endpoint);
  const p256dh = cleanText(keys.p256dh, 200);
  const auth = cleanText(keys.auth, 100);
  if (!endpoint) throw new HttpError(400, "that push service is not one agentsocks will call");
  if (!p256dh || !auth) throw new HttpError(400, "the subscription is missing its keys");
  if (!saveSubscription(ctx.gateway.state, caller.peer.id, endpoint.href, p256dh, auth)) throw new HttpError(409, "that subscription belongs to another device, or this device has too many");
  sendJson(ctx.res, 200, { ok: true });
}

async function unsubscribe(ctx: RequestContext): Promise<void> {
  const caller = callerOf(ctx);
  const body = object(await readJson(ctx.req, MAX_JSON));
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const mine = subscriptionsOf(ctx.gateway.state, caller.peer.id).some((s) => s.endpoint === endpoint);
  if (mine) dropSubscription(ctx.gateway.state, endpoint);
  sendJson(ctx.res, 200, { ok: true });
}

const app = (method: Route["method"], path: string, summary: string, handler: Route["handler"]): Route => ({ method, path, surface: "private", auth: "tailnet", principal: "app", summary, handler });

const ajax = (handler: Route["handler"]): Route["handler"] => async (ctx) => {
  if (ctx.req.headers["x-agentsocks-app"] !== "1") throw new HttpError(403, "this route is for the app's own requests");
  return handler(ctx);
};

export const appRoutes: readonly Route[] = [
  app("GET", "/app", "The phone web app", html),
  app("GET", "/app/", "The phone web app, as the installed app opens it", html),
  app("GET", "/app/manifest.webmanifest", "Web app manifest", webManifest),
  app("GET", "/app/sw.js", "Service worker for Web Push (content-free)", worker),
  app("GET", "/app/icon.png", "Home-screen icon", icon),
  app("GET", "/app/api/state", "Who you are, the peers you can message, unread and task counts, push key", ajax(state)),
  app("GET", "/app/api/inbox", "Unread messages, long-poll up to 25 s; reading marks them read", ajax(inbox)),
  app("GET", "/app/api/history", "Recent messages already read", ajax(history)),
  app("POST", "/app/api/send", "Send a message as the human", ajax(send)),
  app("GET", "/app/api/tasks", "Tasks assigned to or created by the human", ajax(tasks)),
  app("POST", "/app/api/tasks/update", "Move a task", ajax(updateTask)),
  app("POST", "/app/api/push/subscribe", "Register a Web Push subscription", ajax(subscribe)),
  app("POST", "/app/api/push/unsubscribe", "Remove a Web Push subscription", ajax(unsubscribe)),
];
