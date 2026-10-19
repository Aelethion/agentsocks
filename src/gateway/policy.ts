import { createHash } from "node:crypto";
import { SendError } from "../ccsocks.ts";
import type { Broker } from "../broker.ts";
import { decodeAddress } from "../envelope.ts";
import { canonicalPath, threadSocketPath } from "../paths.ts";
import type { Party, Reach, RouteRequest } from "../routing.ts";
import { ALLOW_ALL, gatewayState, mayMessage, normalizeAllowEntry, parseAllow } from "./state.ts";
export function isRemoteThread(broker: Broker, threadId: string): boolean {
  return gatewayState(broker.store).peerByThread(threadId) !== undefined;
}

export function mayReach(broker: Broker, from: Pick<Party, "session">, to: Reach): boolean {
  const sender = gatewayState(broker.store).peerByThread(from.session);
  if (!sender) return true;
  if (sender.disabled) return false;
  const allow = parseAllow(sender.may_message);
  const target = { name: to.name, session: to.session ?? undefined };
  if (mayMessage(allow, target) && mayMessage(allow, { name: broker.currentName(to), session: to.session ?? undefined })) return true;
  return targetFullRefs(to).some((full) => allowHasRef(allow, full));
}

function targetFullRefs(to: Reach): string[] {
  const out: string[] = [];
  if (to.session) {
    try {
      out.push(createHash("sha256").update(threadSocketPath(to.session)).digest("hex"));
    } catch {}
  }
  if (to.addr) {
    try {
      const path = decodeAddress(to.addr);
      if (path) out.push(createHash("sha256").update(canonicalPath(path)).digest("hex"));
    } catch {}
  }
  return out;
}

function allowHasRef(allow: readonly string[], full: string): boolean {
  return allow.some((entry) => {
    const norm = normalizeAllowEntry(entry).toLowerCase();
    return norm !== "" && norm !== ALLOW_ALL && norm.length >= 6 && /^[0-9a-f]+$/.test(norm) && full.startsWith(norm);
  });
}

export function assertMayRoute(broker: Broker, req: RouteRequest): void {
  const sender = gatewayState(broker.store).peerByThread(req.from.session);
  if (!sender) return;
  if (sender.disabled) throw new SendError("not-allowed", `${sender.name} is switched off`);
  const to = { name: req.to.name, addr: req.to.addr, session: req.to.threadId ?? req.to.sessionId ?? null };
  if (!mayReach(broker, req.from, to)) {
    throw new SendError("not-allowed", `${sender.name} may not message ${req.to.name}; the machine's owner sets that list with agentsocks gateway`);
  }
  assertBypassTarget(broker, sender.name, parseAllow(sender.may_message), req);
}

export function assertBypassTarget(broker: Broker, senderName: string, allow: readonly string[], req: RouteRequest): void {
  const threadId = req.to.threadId ?? undefined;
  const thread = threadId ? broker.store.getThread(threadId) : undefined;
  if (!thread || thread.mode !== "bypass") return;
  const lowered = (s: string): string => s.trim().toLowerCase();
  const names = [req.to.name, broker.currentName({ name: req.to.name, addr: req.to.addr, session: threadId ?? null })].map(lowered);
  const explicit = allow.some((entry) => entry !== ALLOW_ALL && (lowered(entry) === lowered(threadId!) || names.includes(lowered(entry))));
  if (!explicit) {
    throw new SendError("not-allowed", `${senderName} may not message ${req.to.name}: it runs with approvals off, so a remote peer reaches it only when the machine's owner names it explicitly in that peer's may-message list (* does not cover it)`);
  }
}

export function scrubRemoteError(msg: string): string {
  return msg
    .replace(/uds:[^\s,)\]]+/gi, "[an address]")
    .replace(/(?<!<)\/[A-Za-z0-9_@.+\-\u0080-\uFFFF]+(?=[^ ]*\/)(?:(?: +|\/)[A-Za-z0-9_@.+\-\u0080-\uFFFF]+)+/g, "[a path]")
    .replace(/(?<!<)\/[A-Za-z0-9_@.+\-\u0080-\uFFFF]*(?:\/[A-Za-z0-9_@.+\-\u0080-\uFFFF]+)+\/?[A-Za-z0-9_@.+\-\u0080-\uFFFF]*/g, "[a path]")
    .replace(/(?<!<)\/[A-Za-z0-9_@.+\-\u0080-\uFFFF]+/g, "[a path]")
    .replace(/[A-Za-z0-9_.-]+\.sock\b/g, "[a socket]");
}
