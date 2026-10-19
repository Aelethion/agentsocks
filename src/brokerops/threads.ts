import type { Broker, HookRequest } from "../broker.ts";
import { gatewayState } from "../gateway/state.ts";
import { isAgentId } from "../agents/types.ts";
import { listClaudeSessions } from "../claude.ts";
import { decodeAddress } from "../envelope.ts";
import { isRemoteThread } from "../gateway/policy.ts";
import { cleanText } from "../limits.ts";
import { canonicalPath, threadSocketPath } from "../paths.ts";
import { sessionDriverSid, threadDriverSid } from "../router.ts";
import { needThread } from "./request.ts";
import type { OpTable } from "./types.ts";

export const livePeerNames = (broker: Broker): string[] =>
  gatewayState(broker.store).listPeers().filter((p) => !p.disabled).map((p) => p.name);

const IMITATION_WORDS = ["remote", "phone", "api", "guest"];

export const normalizeSessionName = (name: string): string => name.normalize("NFKC").replace(/\s+/g, " ").trim();

export function sessionNameRefusal(name: string, peerNames: readonly string[] = []): string | undefined {
  const clean = normalizeSessionName(name);
  const lowered = clean.toLowerCase();
  const word = IMITATION_WORDS.find((w) => new RegExp(`\\(\\s*${w}\\s*\\)`).test(lowered));
  if (word !== undefined) {
    const marker = `(${word})`;
    return `"${name}" carries the gateway marker "${marker}": receivers see remote peers with that marker added, so a local session under that name could imitate another peer`;
  }
  if (clean.includes("@")) return `"${name}" contains "@": receivers read that as a linked session, so a local session under that name could imitate another peer`;
  const clash = peerNames.find((p) => normalizeSessionName(p).toLowerCase() === lowered);
  if (clash !== undefined) return `"${name}" names a connected peer ("${clash}"): receivers could not tell the two apart, so a local session cannot take that name`;
  return undefined;
}

export function sanitizeSessionName(name: string, fallback: string): string {
  const clean = normalizeSessionName(name).replace(/\(\s*(remote|phone|api|guest)\s*\)/gi, " ").replace(/@/g, "-").replace(/\s+/g, " ").trim().replace(/^[\s-]+|[\s-]+$/g, "");
  return clean || fallback;
}

export function assertLocalSessionNameUsable(name: string, peerNames: readonly string[] = []): void {
  const reason = sessionNameRefusal(name, peerNames);
  if (reason !== undefined) throw new Error(reason);
}

const driverThreadOf = (broker: Broker, addr: string): string | undefined => {
  const path = decodeAddress(broker.canon(addr) ?? addr);
  if (!path) return undefined;
  const wanted = canonicalPath(path);
  return broker.store.listThreads().find((t) => canonicalPath(threadSocketPath(t.thread_id)) === wanted)?.thread_id;
};

export const threadOps: OpTable = {
  register: async (broker, req) => ({
    result: await broker.register(needThread(req), {
      ...(isAgentId(req.agent) && { agent: req.agent }),
      ...(typeof req.cwd === "string" && { cwd: req.cwd }),
      ...(typeof req.permissionMode === "string" && { permissionMode: req.permissionMode }),
      ...(typeof req.remote === "string" && { remote: req.remote }),
      ...(typeof req.name === "string" && { name: req.name }),
    }, { strictName: typeof req.name === "string" }),
  }),
  hook: async (broker, req) => {
    if (req.agent !== undefined && !isAgentId(req.agent)) throw new Error("unknown agent");
    return { result: await broker.hook({ ...(req as unknown as HookRequest), threadId: needThread(req) }) };
  },
  list_threads: async (broker) => ({ result: broker.store.listThreads().filter((t) => !isRemoteThread(broker, t.thread_id)).map((t) => broker.describe(t)) }),
  set_name: async (broker, req) => {
    const id = needThread(req);
    const name = cleanText(req.name, 64);
    if (!name) throw new Error("name required");
    if (/^[0-9a-fA-F]{6,64}$/.test(name)) throw new Error(`"${name}" looks like a session ref: allowlists match 6 or more hex characters by ref, so a session renamed to one would receive messages meant for another session`);
    const row = broker.store.getThread(id);
    if (row?.name === undefined || normalizeSessionName(row.name).toLowerCase() !== normalizeSessionName(name).toLowerCase()) {
      const reason = sessionNameRefusal(name, livePeerNames(broker));
      if (reason !== undefined) throw new Error(`${reason}; try "${broker.suggestName(id, name, row?.cwd, row?.agent ?? "codex")}" instead`);
    }
    await broker.register(id, {});
    broker.store.updateThread(id, { name, name_explicit: 1 });
    return { result: broker.describe(broker.store.getThread(id)!) };
  },
  set_driver: async (broker, req) => {
    const id = needThread(req);
    await broker.register(id, {});
    const prevAddr = broker.canon(broker.store.getThread(id)?.driver_addr ?? null);
    if (typeof req.addr !== "string" || !req.addr) {
      broker.store.updateThread(id, { driver_addr: null, driver_name: null, driver_sid: null, driver_instructed_at: null });
    } else {
      const name = cleanText(req.name, 64);
      if (!name) throw new Error("driver name required");
      const target = driverThreadOf(broker, req.addr);
      if (target !== undefined && isRemoteThread(broker, target)) throw new Error("a driver must be a local session: token, OAuth, API and linked peers cannot drive");
      const canonAddr = broker.canon(req.addr) ?? req.addr;
      const path = decodeAddress(canonAddr);
      const live = path ? listClaudeSessions().find((s) => canonicalPath(s.socketPath) === canonicalPath(path)) : undefined;
      const sid = target !== undefined ? threadDriverSid(target) : (live?.sessionId ? sessionDriverSid(live.sessionId) : null);
      const sameDriver = prevAddr !== null && prevAddr === canonAddr;
      broker.store.updateThread(id, { driver_addr: canonAddr, driver_name: name, driver_sid: sid, ...(sameDriver ? {} : { driver_instructed_at: null }) });
    }
    return { result: broker.describe(broker.store.getThread(id)!) };
  },
};
