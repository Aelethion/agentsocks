import { randomUUID } from "node:crypto";
import { postLines, SendError } from "./ccsocks.ts";
import { encodeAddress, userFrame } from "./envelope.ts";
import { killSwitchOn } from "./paths.ts";
import { bodyTooLarge, MAX_BODY_BYTES } from "./limits.ts";
import { listPeers, RESOLVABLE, replyAddress, resolvePeer, ResolveError, type Me, type Peer } from "./peers.ts";
import { OldBrokerError, brokerCall, brokerUnavailable, outcomeUnknown } from "./client.ts";
import { findCodexThread } from "./codexstate.ts";
import { audit } from "./audit.ts";
import { deliveryNote, senderLabel, type RouteSendResult } from "./routing.ts";
import type { Route, Urgency } from "./router.ts";

export interface SendResult {
  msgId: string;
  to: Peer;
  note: string;
  delivered: boolean;
  route?: Route;
}

export interface SendOptions {
  urgency?: Urgency;
  taskId?: string;
  refuseClaudeTargets?: boolean;
  adopt?: boolean;
  brokerOnly?: boolean;
}

const PLAIN_NAME = /^[\w.-]{1,48}$/;

export function nativeSendTo(target: Peer, peers: Peer[]): string {
  const sameName = peers.filter((p) => p.kind === "claude" && p.name.toLowerCase() === target.name.toLowerCase()).length;
  return sameName === 1 && PLAIN_NAME.test(target.name) ? target.name : encodeAddress(target.socketPath);
}

export function nativeSendAdvice(target: Peer, peers: Peer[]): string {
  return `For Claude Code sessions use your built-in SendMessage with to: "${nativeSendTo(target, peers)}". It carries your permission mode, so the message is not held for the receiver's approval.`;
}

export async function resolveTarget(peers: Peer[] | undefined, to: string, me: Me, opts: { allowSelf?: boolean; adopt?: boolean } = {}): Promise<Peer> {
  const { allowSelf = false, adopt = true } = opts;
  const known = peers ?? (await listPeers(RESOLVABLE));
  try {
    const hit = resolvePeer(known, to, me, allowSelf);
    if (hit.connected !== false || !hit.session) return hit;
    if (!adopt) throw new ResolveError(`@${hit.name} is not connected yet, so there is no status to show. A message to it registers it.`);
    return await register(hit.session, undefined, me, allowSelf);
  } catch (err) {
    if (!(err instanceof ResolveError) || !/no running session/.test(err.message) || !adopt) throw err;
    const raw = to.trim().replace(/^@/, "");
    const found = await findCodexThread(/^[0-9a-f-]{36}$/i.test(raw) ? { id: raw } : { name: raw }, { userFacingOnly: true });
    if (!found) throw err;
    return register(found.id, found.cwd, me, allowSelf);
  }
}

async function register(threadId: string, cwd: string | undefined, me: Me, allowSelf: boolean): Promise<Peer> {
  await brokerCall("register", { threadId, ...(cwd && { cwd }) });
  return resolvePeer(await listPeers({ includeStale: true, includeSubagents: true }), threadId, me, allowSelf);
}

export const partyOf = (me: Me) => ({ kind: me.kind, ...(me.agent && { agent: me.agent }), name: me.name, addr: replyAddress(me) ?? null, session: me.session ?? null, mode: me.mode ?? null });

export const targetOf = (target: Peer) => ({
  kind: target.kind === "claude" ? target.kind : "codex",
  addr: encodeAddress(target.socketPath),
  name: target.name,
  ...(target.kind !== "claude" && target.session && { threadId: target.session }),
  ...(target.kind === "claude" && target.session && { sessionId: target.session }),
});

export function routeRequest(me: Me, target: Peer, body: string, msgId: string, opts: SendOptions = {}): Record<string, unknown> {
  return { msgId, from: partyOf(me), to: targetOf(target), body, urgency: opts.urgency ?? "normal", ...(opts.taskId && { taskId: opts.taskId }) };
}

const ROUTE_SEND_TIMEOUT_MS = 15_000;

async function postDirect(me: Me, target: Peer, body: string, why: unknown): Promise<SendResult> {
  const msgId = randomUUID();
  const from = replyAddress(me);
  const frame = userFrame(
    {
      ...(from && { from }),
      ...(me.session && { fromSession: me.session }),
      fromName: senderLabel(me),
      ...(me.mode && { fromMode: me.mode }),
      body,
    },
    msgId,
  );
  await postLines(target.socketPath, [JSON.stringify(frame)]);
  audit("send", { from: me.name, from_kind: me.kind, to: target.name, to_kind: target.kind, msg: msgId, route: "direct" }, body);
  return {
    msgId,
    to: target,
    delivered: true,
    note:
      why instanceof OldBrokerError
        ? `The running agentsocks broker is an older version, so this was posted straight to the session's inbox without attention routing. Run \`agentsocks install\` (or stop pid ${why.pid ?? "of the agentsocks daemon"}) to upgrade it.`
        : "The agentsocks broker could not be reached, so this was posted straight to the session's inbox without attention routing.",
  };
}

function fromRouted(target: Peer, routed: RouteSendResult, urgency: Urgency, visible: readonly string[]): SendResult {
  const delivered = routed.status !== "merged";
  return { msgId: routed.msgId, to: target, delivered, route: routed.decision.route, note: deliveryNote(routed, urgency, visible) };
}

export async function sendMessage(me: Me, to: string, body: string, peers?: Peer[], opts: SendOptions = {}): Promise<SendResult> {
  if (killSwitchOn()) throw new SendError("off", "agentsocks is switched off on this machine (kill switch)");
  if (!body.trim()) throw new SendError("empty", "message is empty");
  if (bodyTooLarge(body)) throw new SendError("too-large", `message is larger than ${MAX_BODY_BYTES / 1024} KiB; send a file path instead`);
  const known = peers ?? (await listPeers(RESOLVABLE));
  const target = await resolveTarget(known, to, me, { adopt: opts.adopt ?? true });
  if (opts.refuseClaudeTargets && target.kind === "claude") throw new SendError("use-sendmessage", nativeSendAdvice(target, known));
  const msgId = randomUUID();
  let routed: RouteSendResult;
  try {
    routed = await brokerCall<RouteSendResult>("route_send", routeRequest(me, target, body, msgId, opts), { timeoutMs: ROUTE_SEND_TIMEOUT_MS });
  } catch (err) {
    if (brokerUnavailable(err)) {
      if (opts.brokerOnly) throw new SendError("unavailable", "the agentsocks broker is not answering");
      return postDirect(me, target, body, err);
    }
    if (outcomeUnknown(err)) {
      throw new SendError("unknown-outcome", `The broker did not answer in time. The message may already be delivered; check with message_status ${msgId} before resending.`);
    }
    throw new SendError("rejected", (err as Error).message);
  }
  if (routed.status === "failed" || routed.status === "refused") throw new SendError(routed.status, routed.error ?? `the message was ${routed.status}`);
  return fromRouted(target, routed, opts.urgency ?? "normal", known.map((p) => p.name));
}
