import type { Broker } from "../broker.ts";
import { audit } from "../audit.ts";
import { SendError } from "../ccsocks.ts";
import { cleanText, validId } from "../limits.ts";
import { killSwitchOn } from "../paths.ts";
import { listPeers, resolvePeer, ResolveError, type Me, type Peer } from "../peers.ts";
import { partyOf, targetOf } from "../send.ts";
import type { MessageRow } from "../store.ts";
import { meOfPeer } from "./gtools.ts";
import { HttpError, readJson, sendJson } from "./http.ts";
import { ensurePeer } from "./remote.ts";
import type { RequestContext, Route } from "./routes.ts";
import type { Gateway } from "./runtime.ts";
import { gatewayState, type PeerRow } from "./state.ts";
import { scrubRemoteError } from "./policy.ts";

const MAX_JSON = 256 * 1024;
const MAX_PEERS = 200;
const MAX_PROXIES_PER_HOST = 200;
const PROXY_IDLE_MS = 7 * 86_400_000;
const MAX_WAIT_SECONDS = 25;
const syncMs = (): number => Number(process.env.AGENTSOCKS_FED_SYNC_MS) || 15_000;
const PUSH_MS = 1000;
const FETCH_TIMEOUT_MS = 10_000;

export const proxyPrefix = (host: string): string => `fed:${host.toLowerCase()}/`;

export interface Listed {
  name: string;
  kind: string;
  status: string;
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "send a JSON object");
  return value as Record<string, unknown>;
};

async function localPeers(): Promise<Peer[]> {
  return (await listPeers({})).filter((p) => p.kind !== "remote" && !p.agent);
}
const listing = (peers: Peer[]): Listed[] => peers.slice(0, MAX_PEERS).map((p) => ({ name: p.name, kind: p.kind, status: p.status ?? "running" }));

function fedTarget(broker: Broker, peers: Peer[], to: string, me?: Me): Peer {
  if (/^\s*@?uds:/i.test(to)) throw new HttpError(400, "name a local Claude or Codex session, not a raw address");
  let target: Peer;
  try {
    target = resolvePeer(peers, to, me);
  } catch (err) {
    if (err instanceof ResolveError) throw new HttpError(404, scrubRemoteError(err.message));
    throw err;
  }
  const remote = target.kind === "remote" || (target.session !== undefined && gatewayState(broker.store).peerByThread(target.session) !== undefined);
  if (remote) throw new HttpError(404, `no running session named "${to.trim().slice(0, 48)}" here`);
  return target;
}

export async function ensureProxy(broker: Broker, host: string, name: string): Promise<PeerRow> {
  const label = cleanText(name, 48);
  const id = `${proxyPrefix(host)}${label}`;
  const state = gatewayState(broker.store);
  const known = state.getPeer(id);
  if (!known || known.disabled) {
    const live = state.listPeers().filter((p) => p.id.startsWith(proxyPrefix(host)) && !p.disabled).length;
    if (live >= MAX_PROXIES_PER_HOST) throw new Error(`${host} has more than ${MAX_PROXIES_PER_HOST} sessions listed here, so no more are added`);
    if (known) state.updatePeer(id, { disabled: 0 });
  }
  return ensurePeer(broker, { id, name: `${label}@${host}`, via: "tailnet", machine: host, mayMessage: ["*"], detail: { federation: { host, name: label } } });
}

export function pruneProxies(broker: Broker, now = Date.now()): number {
  const state = gatewayState(broker.store);
  let pruned = 0;
  for (const peer of state.listPeers()) {
    if (!peer.id.startsWith("fed:") || peer.disabled || (peer.last_seen ?? peer.created_at) >= now - PROXY_IDLE_MS) continue;
    if (broker.store.queuedCount(peer.thread_id, false) > 0) continue;
    state.updatePeer(peer.id, { disabled: 1 });
    pruned++;
  }
  return pruned;
}

const remoteName = (peer: PeerRow): string => {
  try {
    return String((JSON.parse(peer.detail) as { federation?: { name?: unknown } }).federation?.name ?? "");
  } catch {
    return "";
  }
};

async function selfLabel(gateway: Gateway): Promise<string> {
  const own = await gateway.tailnet.self();
  return own ? own.dnsName.split(".")[0]! : "unknown";
}

function hostOf(ctx: RequestContext): string {
  if (ctx.auth.kind !== "host") throw new Error("federation route reached without a host identity");
  return ctx.auth.host;
}

async function exchange(ctx: RequestContext): Promise<void> {
  const host = hostOf(ctx);
  const body = object(await readJson(ctx.req, MAX_JSON));
  const theirs = Array.isArray(body.peers) ? body.peers.slice(0, MAX_PEERS) : [];
  for (const item of theirs) {
    const name = typeof item === "object" && item && typeof (item as Listed).name === "string" ? cleanText((item as Listed).name, 48) : "";
    if (!name) continue;
    try {
      await ensureProxy(ctx.broker, host, name);
    } catch {
      break;
    }
  }
  sendJson(ctx.res, 200, { host: await selfLabel(ctx.gateway), peers: listing(await localPeers()) });
}

async function forward(ctx: RequestContext): Promise<void> {
  const host = hostOf(ctx);
  const body = object(await readJson(ctx.req, MAX_JSON));
  const msgId = validId(body.msgId);
  const from = cleanText(body.from, 48);
  const to = typeof body.to === "string" ? body.to : "";
  const text = typeof body.body === "string" ? body.body : "";
  const urgency = body.urgency === "urgent" || body.urgency === "fyi" ? body.urgency : "normal";
  if (!msgId || !from || !to.trim() || !text.trim()) throw new HttpError(400, "send msgId, from, to and body");
  let sender: PeerRow;
  try {
    sender = await ensureProxy(ctx.broker, host, from);
  } catch (err) {
    throw new HttpError(429, (err as Error).message);
  }
  const target = fedTarget(ctx.broker, await localPeers(), to, meOfPeer(ctx.broker, sender));
  try {
    const sent = await ctx.broker.routeSend({ msgId, from: partyOf(meOfPeer(ctx.broker, sender)), to: targetOf(target), body: text, urgency });
    if (sent.status === "failed" || sent.status === "refused") throw new HttpError(422, scrubRemoteError(sent.error ?? `the message was ${sent.status}`));
    sendJson(ctx.res, 200, { ok: true, status: sent.status, route: sent.decision.route, to: { name: sent.to.name, kind: sent.to.kind } });
  } catch (err) {
    if (err instanceof SendError) throw new HttpError(err.code === "rate-limited" ? 429 : 422, scrubRemoteError(err.message));
    throw err;
  }
}

const proxiesOf = (ctx: RequestContext, host: string): PeerRow[] => ctx.gateway.state.listPeers().filter((p) => p.id.startsWith(proxyPrefix(host)) && !p.disabled);

function urgencyOf(row: MessageRow): string {
  try {
    return String((JSON.parse(row.decision ?? "{}") as { urgency?: unknown }).urgency ?? "normal");
  } catch {
    return "normal";
  }
}

async function pull(ctx: RequestContext): Promise<void> {
  const host = hostOf(ctx);
  if (ctx.auth.kind !== "host") throw new Error("federation route reached without a host identity");
  const owner = (await ctx.gateway.tailnet.self())?.login;
  if (!owner) return sendJson(ctx.res, 200, { items: [] });
  const asked = Number(ctx.url.searchParams.get("wait") ?? 0);
  const deadline = Date.now() + Math.max(0, Math.min(Number.isFinite(asked) ? asked : 0, MAX_WAIT_SECONDS)) * 1000;
  const { req, res, broker } = ctx;
  for (;;) {
    if (ctx.gateway.state.host(host)?.allowed !== 1) return sendJson(res, 200, { items: [] });
    if (!loginAllowed(ctx.gateway, ctx.auth.identity.login, owner)) return sendJson(res, 200, { items: [] });
    const items: Record<string, unknown>[] = [];
    for (const proxy of proxiesOf(ctx, host)) {
      const { messages } = broker.store.peek(proxy.thread_id, 64_000);
      const receipts = messages.filter((m) => m.kind === "receipt");
      if (receipts.length > 0) broker.store.markSurfaced(receipts.map((m) => m.id));
      for (const m of messages.filter((x) => x.kind === "message")) {
        items.push({ id: m.id, msgId: m.msg_id, proxy: remoteName(proxy), from: m.from_name ?? "unknown", body: m.body, urgency: urgencyOf(m), at: m.received_at });
      }
    }
    if (items.length > 0 || Date.now() >= deadline || res.destroyed || req.socket.destroyed) return sendJson(res, 200, { items });
    await new Promise((r) => setTimeout(r, 250));
  }
}

const loginAllowed = (gateway: Gateway, login: string, owner: string): boolean => {
  const lowered = login.toLowerCase();
  return lowered === owner.toLowerCase() || gateway.allowedLogins().some((l) => l.toLowerCase() === lowered);
};

async function ack(ctx: RequestContext): Promise<void> {
  const host = hostOf(ctx);
  const body = object(await readJson(ctx.req, MAX_JSON));
  const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
  const mine = new Map(proxiesOf(ctx, host).map((p) => [p.thread_id, p]));
  const now = Date.now();
  for (const raw of items) {
    const item = object(raw);
    const row = typeof item.id === "string" ? (ctx.broker.store.db.prepare("SELECT * FROM messages WHERE id = ?").get(item.id) as MessageRow | undefined) : undefined;
    if (!row || !mine.has(row.to_thread)) continue;
    ctx.broker.store.markSurfaced([row.id], now);
    if (item.ok === true) ctx.broker.store.markShown([row.msg_id], row.to_thread, now);
    else ctx.broker.store.db.prepare("UPDATE outbox SET status = 'failed', error = ? WHERE msg_id = ? AND to_thread = ? AND status IN ('sent', 'held')").run(`${host} could not deliver it: ${cleanText(item.error, 160) || "unknown reason"}`, row.msg_id, row.to_thread);
  }
  sendJson(ctx.res, 200, { ok: true });
}

const fed = (method: Route["method"], path: string, summary: string, handler: Route["handler"]): Route => ({ method, path, surface: "private", auth: "tailnet", principal: "host", summary, handler });

export const federationRoutes: readonly Route[] = [
  fed("POST", "/federation/peers", "Exchange peer lists with a machine that was allowed to link", exchange),
  fed("POST", "/federation/send", "Deliver a message from a linked machine to a local session", forward),
  fed("GET", "/federation/pull", "A linked machine collects replies addressed to its sessions, long-poll", pull),
  fed("POST", "/federation/ack", "A linked machine confirms what it delivered", ack),
];

export interface LinkStatus {
  host: string;
  url: string;
  connected: boolean;
  error?: string;
  lastSync: number | null;
}

class FedClient {
  readonly base: string;

  constructor(base: string) {
    this.base = base.replace(/\/$/, "");
  }

  async call(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = FETCH_TIMEOUT_MS, stop?: AbortSignal): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: stop ? AbortSignal.any([AbortSignal.timeout(timeoutMs), stop]) : AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {}
    if (res.status >= 300) throw Object.assign(new Error(typeof json.error === "string" ? json.error : `${this.base} answered ${res.status}`), { status: res.status });
    return json;
  }
}

export function linkUrl(target: string, ownDns: string | undefined): string {
  if (/^https?:\/\//i.test(target)) {
    const url = new URL(target);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !loopback) throw new Error("a linked machine is reached over https; plain http is only for this machine");
    if (url.username || url.password) throw new Error("the address must not carry a user name or password");
    return url.origin;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(target)) throw new Error("give the machine's tailnet name (for example hetzner-lab) or its https address");
  const suffix = ownDns?.split(".").slice(1).join(".");
  if (!suffix) throw new Error("tailscale did not say this tailnet's domain; give the machine's full https address instead");
  return `https://${target}.${suffix}`;
}

class Link {
  readonly host: string;
  readonly url: string;
  private readonly gateway: Gateway;
  private readonly client: FedClient;
  private readonly abort = new AbortController();
  private readonly done: Promise<unknown>[] = [];
  status: LinkStatus;

  constructor(gateway: Gateway, host: string, url: string) {
    this.gateway = gateway;
    this.host = host;
    this.url = url;
    this.client = new FedClient(url);
    this.status = { host, url, connected: false, lastSync: null };
  }

  start(): void {
    this.done.push(this.forever(() => this.sync()), this.forever(() => this.push()), this.forever(() => this.pull()));
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.done);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    });
  }

  private async forever(step: () => Promise<number>): Promise<void> {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        if (killSwitchOn()) {
          await this.sleep(2000);
          continue;
        }
        const next = await step();
        failures = 0;
        await this.sleep(next);
      } catch (err) {
        failures++;
        const status = (err as { status?: number }).status;
        this.status = { ...this.status, connected: false, error: (err as Error).message };
        if (failures === 1) audit("federation_error", { host: this.host, error: (err as Error).message });
        await this.sleep(status === 403 ? 60_000 : Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)));
      }
    }
  }

  private async sync(): Promise<number> {
    const answer = await this.client.call("POST", "/federation/peers", { peers: listing(await localPeers()) }, FETCH_TIMEOUT_MS, this.abort.signal);
    const theirs = Array.isArray(answer.peers) ? (answer.peers as Listed[]).slice(0, MAX_PEERS) : [];
    await this.gateway.federation.adopt(this.host, theirs);
    const { error: _error, ...rest } = this.status;
    this.status = { ...rest, connected: true, lastSync: Date.now() };
    return syncMs();
  }

  private async push(): Promise<number> {
    const { broker, state } = this.gateway;
    let sent = 0;
    for (const proxy of state.listPeers().filter((p) => p.id.startsWith(proxyPrefix(this.host)) && !p.disabled)) {
      const { messages } = broker.store.peek(proxy.thread_id, 64_000);
      for (const m of messages.filter((x) => x.kind === "message")) {
        if (killSwitchOn()) return PUSH_MS;
        if (m.from_kind === "remote") {
          this.fail(m, proxy, "remote peers cannot message another machine through a link; use that machine's own gateway");
          continue;
        }
        const from = (m.from_name ?? "unknown").replace(/ \(codex\)$/, "");
        try {
          await this.client.call("POST", "/federation/send", { msgId: m.msg_id, from, to: remoteName(proxy), body: m.body, urgency: urgencyOf(m) }, FETCH_TIMEOUT_MS, this.abort.signal);
          broker.store.markSurfaced([m.id]);
          broker.store.markShown([m.msg_id], m.to_thread, Date.now());
          sent++;
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === undefined || status >= 500 || status === 429 || status === 403) throw err;
          this.fail(m, proxy, (err as Error).message);
        }
      }
    }
    return sent > 0 ? 100 : PUSH_MS;
  }

  private fail(m: MessageRow, proxy: PeerRow, why: string): void {
    const { broker } = this.gateway;
    broker.store.markSurfaced([m.id]);
    broker.store.db.prepare("UPDATE outbox SET status = 'failed', error = ? WHERE msg_id = ? AND to_thread = ? AND status IN ('sent', 'held')").run(`${proxy.name}: ${why}`.slice(0, 300), m.msg_id, m.to_thread);
  }

  private async pull(): Promise<number> {
    const got = await this.client.call("GET", `/federation/pull?wait=${MAX_WAIT_SECONDS - 5}`, undefined, (MAX_WAIT_SECONDS + 10) * 1000, this.abort.signal);
    const items = Array.isArray(got.items) ? (got.items as Record<string, unknown>[]) : [];
    if (items.length === 0) return 50;
    const results: { id: unknown; ok: boolean; error?: string }[] = [];
    for (const item of items) results.push(await this.deliver(item));
    await this.client.call("POST", "/federation/ack", { items: results }, FETCH_TIMEOUT_MS, this.abort.signal);
    return 0;
  }

  private async deliver(item: Record<string, unknown>): Promise<{ id: unknown; ok: boolean; error?: string }> {
    const { broker } = this.gateway;
    try {
      const msgId = validId(item.msgId);
      const from = cleanText(item.from, 48);
      const text = typeof item.body === "string" ? item.body : "";
      if (!msgId || !from || !text.trim()) throw new Error("the item is malformed");
      let target: Peer;
      try {
        target = fedTarget(broker, await localPeers(), String(item.proxy ?? ""));
      } catch (err) {
        throw new Error(err instanceof HttpError ? err.message : (err as Error).message);
      }
      const sender = await ensureProxy(broker, this.host, from);
      const urgency = item.urgency === "urgent" || item.urgency === "fyi" ? item.urgency : "normal";
      const sent = await broker.routeSend({ msgId, from: partyOf(meOfPeer(broker, sender)), to: targetOf(target), body: text, urgency });
      if (sent.status === "failed" || sent.status === "refused") throw new Error(sent.error ?? `the message was ${sent.status}`);
      return { id: item.id, ok: true };
    } catch (err) {
      return { id: item.id, ok: false, error: scrubRemoteError((err as Error).message).slice(0, 160) };
    }
  }
}

export function hostFromLinkUrl(url: string, ownDns: string | undefined): string {
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
  const suffix = ownDns?.split(".").slice(1).join(".").toLowerCase();
  if (suffix && hostname !== suffix && hostname.endsWith(`.${suffix}`)) return hostname.slice(0, -suffix.length - 1).split(".")[0]!;
  if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(hostname)) return hostname;
  return "";
}

const isLoopbackUrl = (url: string): boolean => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};

export class Federation {
  private readonly gateway: Gateway;
  private readonly links = new Map<string, Link>();

  constructor(gateway: Gateway) {
    this.gateway = gateway;
  }

  async reconcile(): Promise<void> {
    const wanted = killSwitchOn() ? [] : this.gateway.state.hosts().filter((h) => h.linked === 1 && h.url);
    for (const [host, link] of [...this.links]) {
      const row = wanted.find((h) => h.host === host);
      if (!row || row.url !== link.url) {
        this.links.delete(host);
        await link.stop();
      }
    }
    for (const row of wanted) {
      if (this.links.has(row.host)) continue;
      const link = new Link(this.gateway, row.host, row.url!);
      this.links.set(row.host, link);
      link.start();
    }
  }

  async adopt(host: string, theirs: Listed[]): Promise<void> {
    for (const p of theirs) {
      if (typeof p?.name !== "string" || !p.name) continue;
      try {
        await ensureProxy(this.gateway.broker, host, p.name);
      } catch {
        return;
      }
    }
  }

  statuses(): LinkStatus[] {
    return [...this.links.values()].map((l) => l.status);
  }



  async handshake(url: string): Promise<{ host: string; peers: number }> {
    if (isLoopbackUrl(url)) {
      const answer = await new FedClient(url).call("POST", "/federation/peers", { peers: listing(await localPeers()) });
      const claimed = typeof answer.host === "string" ? cleanText(answer.host, 48).toLowerCase() : "";
      if (!claimed || claimed === "unknown") throw new Error(`${url} did not say which machine it is`);
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(claimed)) throw new Error(`${url} says it is "${claimed}", which is not a tailscale machine name`);
      const theirs = Array.isArray(answer.peers) ? (answer.peers as Listed[]).slice(0, MAX_PEERS) : [];
      await this.adopt(claimed, theirs);
      return { host: claimed, peers: theirs.length };
    }
    const ownDns = (await this.gateway.tailnet.self())?.dnsName;
    if (!ownDns || ownDns.split(".").length < 2) throw new Error("tailscale did not say this tailnet's domain; give the machine's full https address instead");
    const derived = hostFromLinkUrl(url, ownDns);
    if (!derived) throw new Error(`${url} is outside this tailnet, so its name cannot be checked; link a machine in your own tailnet by name or https address`);
    const answer = await new FedClient(url).call("POST", "/federation/peers", { peers: listing(await localPeers()) });
    const claimed = typeof answer.host === "string" ? cleanText(answer.host, 48).toLowerCase() : "";
    if (!claimed || claimed === "unknown") throw new Error(`${url} did not say which machine it is`);
    if (derived !== claimed) throw new Error(`${url} says it is "${claimed}" but its address names "${derived}"; not linking a machine that misstates its own name`);
    const theirs = Array.isArray(answer.peers) ? (answer.peers as Listed[]).slice(0, MAX_PEERS) : [];
    await this.adopt(derived, theirs);
    return { host: derived, peers: theirs.length };
  }

  async stop(): Promise<void> {
    const links = [...this.links.values()];
    this.links.clear();
    await Promise.all(links.map((l) => l.stop()));
  }
}
