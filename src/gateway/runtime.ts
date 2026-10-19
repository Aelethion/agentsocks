import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import type { Broker } from "../broker.ts";
import { audit } from "../audit.ts";
import { killSwitchOn, stateDir } from "../paths.ts";
import { authenticateBearer } from "./bearer.ts";
import { authenticateTailnet, checkBrowserOrigin, type TailnetIdentity } from "./auth.ts";
import { HttpError, isCanonicalPath, lastForwardedFor, sendError } from "./http.ts";
import { ApiPeers } from "./apipeer.ts";
import { Federation } from "./federation.ts";
import { FailureWindow } from "./failures.ts";
import { TokenBuckets } from "../limits.ts";
import { ensurePeer } from "./remote.ts";
import { remoteFromName } from "./tokens.ts";
import { ROUTES } from "./table.ts";
import type { Authenticated, Route, Surface } from "./routes.ts";
import { archiveGatewayState, disableGatewayState, gatewayState, randomLoopbackPort, type GatewayState } from "./state.ts";
import { funnelOffCommand, runCommand, serveOffCommand } from "./expose.ts";
import { sourceCheck } from "./source.ts";
import { localTailnet, type Tailnet } from "./tailscale.ts";

export const DEFAULT_PRIVATE_PORT = 8787;
export const DEFAULT_PUBLIC_PORT = 8788;
const LOOPBACK = "127.0.0.1";

const headersTimeoutMs = (): number => Number(process.env.AGENTSOCKS_GATEWAY_HEADERS_MS) || 10_000;
const requestTimeoutMs = (): number => Number(process.env.AGENTSOCKS_GATEWAY_REQUEST_MS) || 30_000;
const sourceConnCap = (surface: Surface): number => Number(process.env.AGENTSOCKS_GATEWAY_SOURCE_CONNS) || (surface === "public" ? 32 : 16);
const pendingCap = (surface: Surface): number => Number(process.env.AGENTSOCKS_GATEWAY_PENDING_CONNS) || (surface === "public" ? 128 : 64);
const maxConns = (surface: Surface): number => (surface === "public" ? 128 : 64);

const POLL_PATHS: Record<string, true> = { "/mcp": true, "/federation/pull": true, "/app/api/inbox": true };
export const isPollRoute = (pathname: string): boolean => POLL_PATHS[pathname] === true;

export interface PrivateSettings {
  enabled: boolean;
  port: number;
  served: boolean;
}

export interface PublicSettings {
  enabled: boolean;
  port: number;
  via: "funnel" | "cloudflared";
  url?: string;
  exposed?: boolean;
}

export interface ListenerStatus {
  surface: Surface;
  wanted: boolean;
  listening: boolean;
  port: number | null;
  error?: string;
}

export interface PollInfo {
  peerId?: string;
  via?: string;
  route?: string;
}

export interface StopSummary {
  reason: string;
  privateStopped: boolean;
  publicStopped: boolean;
  federationLinks: number;
  apiPeers: number;
  polls: number;
  serveUndone: boolean;
  funnelUndone: boolean;
}
interface Running {
  server: Server;
  port: number;
  wantedPort: number;
}

const parse = <T>(raw: string | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(raw) as object) };
  } catch {
    return fallback;
  }
};

export class Gateway {
  readonly broker: Broker;
  readonly tailnet: Tailnet;
  readonly state: GatewayState;
  requests = 0;
  lastActivity: number | null = null;
  readonly limits = {
    authFailures: new FailureWindow(20, 60_000),
    oauthCalls: new FailureWindow(60, 60_000),
    pairing: new FailureWindow(5, 600_000),
    pairingAll: new FailureWindow(30, 600_000),
    peerRate: new TokenBuckets(60, 1),
    preAuthSource: new TokenBuckets(120, 20),
    preAuthAll: new TokenBuckets(600, 100),
  };
  readonly federation = new Federation(this);
  readonly apiPeers = new ApiPeers(this);
  private running = new Map<Surface, Running>();
  private errors = new Map<Surface, string>();
  private chain: Promise<unknown> = Promise.resolve();
  private polls = new Map<number, { info: PollInfo; close: () => void }>();
  private nextPoll = 1;
  private connSource = new WeakMap<Socket, string>();
  private sourceConns = new Map<string, Set<Socket>>();
  private requestedConns = new Map<Surface, number>();
  private sockBusy = new Set<Socket>();
  private sockActive = new Map<Socket, number>();
  readonly source = sourceCheck();

  constructor(broker: Broker, tailnet: Tailnet = localTailnet()) {
    this.broker = broker;
    this.tailnet = tailnet;
    this.state = gatewayState(broker.store);
    if (!this.state.setting("private")) this.savePrivate({ enabled: false, port: randomLoopbackPort(), served: false });
    if (!this.state.setting("public")) this.savePublic({ enabled: false, port: randomLoopbackPort(), via: "funnel" });
  }

  privateSettings(): PrivateSettings {
    return parse<PrivateSettings>(this.state.setting("private"), { enabled: false, port: DEFAULT_PRIVATE_PORT, served: false });
  }

  publicSettings(): PublicSettings {
    return parse<PublicSettings>(this.state.setting("public"), { enabled: false, port: DEFAULT_PUBLIC_PORT, via: "funnel" });
  }

  allowedLogins(): string[] {
    try {
      const value: unknown = JSON.parse(this.state.setting("logins") ?? "[]");
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }

  saveLogins(logins: readonly string[]): void {
    this.state.setSetting("logins", JSON.stringify([...new Set(logins.map((l) => l.trim().toLowerCase()))]));
  }

  savePrivate(next: PrivateSettings): void {
    this.state.setSetting("private", JSON.stringify(next));
  }

  savePublic(next: PublicSettings): void {
    this.state.setSetting("public", JSON.stringify(next));
  }

  port(surface: Surface): number | null {
    return this.running.get(surface)?.port ?? null;
  }

  paused(): boolean {
    return this.state.setting("paused") === "1";
  }

  resume(): void {
    if (this.paused()) this.state.deleteSetting("paused");
  }

  reconcile(): Promise<void> {
    const run = this.chain.then(() => this.apply());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async apply(): Promise<void> {
    const off = killSwitchOn();
    if (off) this.closePollsFor(() => true);
    if (this.paused()) {
      await this.federation.stop();
      await this.apiPeers.stop();
      this.closePollsFor(() => true);
    } else {
      await this.federation.reconcile();
      await this.apiPeers.reconcile();
    }
    const wanted: [Surface, boolean, number][] = [
      ["private", this.privateSettings().enabled && !off, this.privateSettings().port],
      ["public", this.publicSettings().enabled && !off, this.publicSettings().port],
    ];
    for (const [surface, want, port] of wanted) {
      const current = this.running.get(surface);
      if (current && (!want || current.wantedPort !== port)) await this.close(surface);
      if (want && !this.running.has(surface)) await this.open(surface, port);
    }
  }

  private async open(surface: Surface, port: number): Promise<void> {
    const server = createServer((req, res) => void this.handle(surface, req, res));
    server.maxConnections = 512;
    server.headersTimeout = headersTimeoutMs();
    server.requestTimeout = 330_000;
    server.keepAliveTimeout = 5_000;
    const pending = new Set<Socket>();
    const firstByte = new WeakMap<Socket, NodeJS.Timeout>();
    server.on("connection", (socket) => {
      const timer = setTimeout(() => socket.destroy(), headersTimeoutMs());
      timer.unref();
      firstByte.set(socket, timer);
      pending.add(socket);
      socket.once("close", () => {
        clearTimeout(timer);
        pending.delete(socket);
      });
      if (pending.size > pendingCap(surface)) pending.values().next().value?.destroy();
    });
    server.on("request", (req) => {
      const timer = firstByte.get(req.socket);
      if (timer !== undefined) {
        clearTimeout(timer);
        firstByte.delete(req.socket);
      }
      pending.delete(req.socket);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: LOOPBACK, port }, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.errors.set(surface, code === "EADDRINUSE" ? `port ${port} on 127.0.0.1 is already in use by another process, so the ${surface} listener did not start; pick another with --port` : (err as Error).message);
      await this.releaseExposure(surface);
      return;
    }
    this.errors.delete(surface);
    const bound = (server.address() as AddressInfo).port;
    if (port === 0) this.rememberPort(surface, bound);
    this.running.set(surface, { server, port: bound, wantedPort: port === 0 ? bound : port });
    audit("gateway_listen", { surface, port: bound });
  }

  private rememberPort(surface: Surface, port: number): void {
    if (surface === "private") this.savePrivate({ ...this.privateSettings(), port });
    else this.savePublic({ ...this.publicSettings(), port });
  }

  private async releaseExposure(surface: Surface): Promise<void> {
    if (surface === "private") {
      const now = this.privateSettings();
      if (!now.served) return;
      if ((await runCommand(serveOffCommand(now.port))) !== 0) {
        audit("gateway_serve_off_failed", { surface, port: now.port });
        return;
      }
      this.savePrivate({ ...now, served: false });
    } else {
      const now = this.publicSettings();
      if (!now.exposed) return;
      if ((await runCommand(funnelOffCommand(now.port))) !== 0) {
        audit("gateway_funnel_off_failed", { surface, port: now.port });
        return;
      }
      this.savePublic({ ...now, exposed: false });
    }
  }

  async close(surface: Surface): Promise<void> {
    const current = this.running.get(surface);
    if (!current) return;
    this.running.delete(surface);
    current.server.closeAllConnections();
    await new Promise<void>((resolve) => current.server.close(() => resolve()));
    audit("gateway_close", { surface });
  }

  async stop(): Promise<void> {
    await this.chain.catch(() => undefined);
    await this.federation.stop();
    await this.apiPeers.stop();
    this.closePollsFor(() => true);
    for (const surface of [...this.running.keys()]) await this.close(surface);
  }

  registerPoll(info: PollInfo, close: () => void): () => void {
    const id = this.nextPoll++;
    this.polls.set(id, { info, close });
    return () => {
      this.polls.delete(id);
    };
  }

  closePollsFor(match: (peerId: string) => boolean): number {
    let ended = 0;
    for (const [id, poll] of [...this.polls]) {
      if (!match(poll.info.peerId ?? "")) continue;
      this.polls.delete(id);
      try {
        poll.close();
      } catch (err) {
        audit("gateway_poll_close", { error: (err as Error).message });
      }
      ended++;
    }
    return ended;
  }

  async shutdown(reason: string): Promise<StopSummary> {
    await this.chain.catch(() => undefined);
    const priv = this.privateSettings();
    const pub = this.publicSettings();
    const summary: StopSummary = {
      reason,
      privateStopped: this.running.has("private"),
      publicStopped: this.running.has("public"),
      federationLinks: this.federation.statuses().length,
      apiPeers: this.state.listPeers().filter((p) => p.via === "api" && !p.disabled).length,
      polls: 0,
      serveUndone: false,
      funnelUndone: false,
    };
    summary.polls = this.closePollsFor(() => true);
    await this.federation.stop();
    await this.apiPeers.stop();
    for (const surface of [...this.running.keys()]) await this.close(surface);
    if (priv.served) {
      summary.serveUndone = (await runCommand(serveOffCommand(priv.port))) === 0;
      if (summary.serveUndone) priv.served = false;
      else audit("gateway_serve_off_failed", { surface: "private", port: priv.port, reason });
    }
    if (pub.exposed) {
      summary.funnelUndone = (await runCommand(funnelOffCommand(pub.port))) === 0;
      if (summary.funnelUndone) pub.exposed = false;
      else audit("gateway_funnel_off_failed", { surface: "public", port: pub.port, reason });
    }
    this.savePrivate({ ...priv, enabled: false });
    this.savePublic({ ...pub, enabled: false });
    this.state.setSetting("paused", "1");
    return summary;
  }

  listeners(): ListenerStatus[] {
    const priv = this.privateSettings();
    const pub = this.publicSettings();
    return ([
      ["private", priv.enabled],
      ["public", pub.enabled],
    ] as [Surface, boolean][]).map(([surface, wanted]) => ({
      surface,
      wanted,
      listening: this.running.has(surface),
      port: this.port(surface),
      ...(this.errors.has(surface) && { error: this.errors.get(surface)! }),
    }));
  }

  private async handle(surface: Surface, req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requests++;
    this.lastActivity = Date.now();
    const finish: (() => void)[] = [];
    res.once("finish", () => finish.forEach((fn) => fn()));
    try {
      if (killSwitchOn()) {
        this.closePollsFor(() => true);
        throw new HttpError(503, "agentsocks is switched off on this machine");
      }
      if (surface === "private" && !(await this.source.checkSource(req))) {
        finish.push(() => req.socket.destroy());
        throw new HttpError(403, "the request did not come through tailscale serve", { Connection: "close" });
      }
      this.admitSource(surface, req);
      this.sockBusy.add(req.socket);
      this.sockActive.set(req.socket, Date.now());
      finish.push(() => {
        this.sockBusy.delete(req.socket);
        this.sockActive.set(req.socket, Date.now());
      });
      this.preAuth(req);
      if (!req.url?.startsWith("/")) throw new HttpError(400, "bad request target");
      const url = new URL(req.url, "http://gateway.invalid");
      if (!isCanonicalPath(req.url.split(/[?#]/, 1)[0]!)) throw new HttpError(404, "not found");
      const route = this.find(surface, req.method ?? "GET", url.pathname);
      if (!isPollRoute(url.pathname)) {
        const timer = setTimeout(() => {
          if (!res.writableEnded) res.destroy();
        }, requestTimeoutMs());
        timer.unref();
        finish.push(() => clearTimeout(timer));
        res.once("close", () => clearTimeout(timer));
      }
      const auth = await this.authenticate(route, req);
      this.charge(auth);
      if (auth.kind === "peer") {
        const forget = this.registerPoll({ peerId: auth.caller.peer.id, via: auth.caller.via, route: url.pathname }, () => {
          if (!res.writableEnded) res.destroy();
        });
        res.once("close", forget);
      }
      await route.handler({ broker: this.broker, gateway: this, surface, req, res, url, auth, afterResponse: (fn) => finish.push(fn) });
    } catch (err) {
      sendError(res, err);
    }
  }

  private admitSource(surface: Surface, req: IncomingMessage): void {
    const source = lastForwardedFor(req) ?? req.socket.remoteAddress ?? "unknown";
    const key = `${surface}:${source}`;
    if (this.connSource.get(req.socket) !== undefined) {
      this.sockActive.set(req.socket, Date.now());
      return;
    }
    const live = this.sourceConns.get(key);
    if ((live?.size ?? 0) >= sourceConnCap(surface)) throw new HttpError(503, "too many connections from this source", { "Retry-After": "1" });
    if ((this.requestedConns.get(surface) ?? 0) >= maxConns(surface) && !this.shedIdleKeepAlive(surface)) {
      throw new HttpError(503, "the listener is full", { "Retry-After": "1" });
    }
    const tracked = this.sourceConns.get(key);
    if (tracked) tracked.add(req.socket);
    else this.sourceConns.set(key, new Set([req.socket]));
    this.requestedConns.set(surface, (this.requestedConns.get(surface) ?? 0) + 1);
    this.connSource.set(req.socket, key);
    req.socket.once("close", () => this.forgetSocket(req.socket));
  }

  private shedIdleKeepAlive(surface: Surface): boolean {
    const prefix = `${surface}:`;
    let victim: Socket | undefined;
    let victimAt = Infinity;
    for (const [key, set] of this.sourceConns) {
      if (!key.startsWith(prefix)) continue;
      for (const socket of set) {
        if (this.sockBusy.has(socket)) continue;
        const at = this.sockActive.get(socket) ?? 0;
        if (at < victimAt) {
          victim = socket;
          victimAt = at;
        }
      }
    }
    if (!victim) return false;
    this.forgetSocket(victim);
    try {
      victim.destroy();
    } catch {
    }
    return true;
  }

  private forgetSocket(socket: Socket): void {
    const key = this.connSource.get(socket);
    if (key === undefined) return;
    this.connSource.delete(socket);
    const surface = key.slice(0, key.indexOf(":")) as Surface;
    const current = this.sourceConns.get(key);
    current?.delete(socket);
    if (current && current.size === 0) this.sourceConns.delete(key);
    const left = (this.requestedConns.get(surface) ?? 1) - 1;
    if (left <= 0) this.requestedConns.delete(surface);
    else this.requestedConns.set(surface, left);
    this.sockBusy.delete(socket);
    this.sockActive.delete(socket);
  }

  private preAuth(req: IncomingMessage): void {
    const now = Date.now();
    const source = lastForwardedFor(req) ?? req.socket.remoteAddress ?? "unknown";
    if (!this.limits.preAuthSource.take(source, now)) throw new HttpError(429, "too many requests", { "Retry-After": "1" });
    if (!this.limits.preAuthAll.take("all", now)) throw new HttpError(429, "too many requests", { "Retry-After": "1" });
  }

  private charge(auth: Authenticated): void {
    if (auth.kind === "none") return;
    const key = auth.kind === "peer" ? auth.caller.peer.id : `host:${auth.host}`;
    if (!this.limits.peerRate.take(key, Date.now())) throw new HttpError(429, "too many requests", { "Retry-After": "2" });
  }

  private find(surface: Surface, method: string, pathname: string): Route {
    const onPath = ROUTES.filter((r) => r.surface === surface && r.path === pathname);
    if (onPath.length === 0) throw new HttpError(404, "not found");
    const hit = onPath.find((r) => r.method === method);
    if (!hit) throw new HttpError(405, "method not allowed", { Allow: onPath.map((r) => r.method).join(", ") });
    return hit;
  }

  private async authenticate(route: Route, req: IncomingMessage): Promise<Authenticated> {
    if (route.auth === "none" || route.auth === "pairing") return { kind: "none" };
    if (route.auth === "bearer") return { kind: "peer", caller: await authenticateBearer(this, req) };
    await checkBrowserOrigin(req, this.tailnet);
    const identity = await authenticateTailnet(req, {
      tailnet: this.tailnet,
      extraLogins: () => this.allowedLogins(),
    });
    if (route.principal === "host") {
      if (!this.state.host(identity.node)?.allowed) throw new HttpError(403, `this machine has not allowed ${identity.node} to link; run: agentsocks gateway allow ${identity.node}`);
      return { kind: "host", host: identity.node.toLowerCase(), identity };
    }
    const peer = await ensurePeer(this.broker, tailnetPeer(identity, route.principal ?? "agent", (await this.tailnet.self())?.login));
    return { kind: "peer", caller: { peer, via: "tailnet", surface: "private", toolset: "full", identity } };
  }
}

export function tailnetPeer(identity: TailnetIdentity, principal: "agent" | "app", ownerLogin?: string) {
  const local = identity.login.split("@")[0]!;
  const phone = identity.os === "iOS" || identity.os === "android";
  const base = principal === "app" ? `${local} (${phone ? "phone" : identity.node})` : identity.node;
  const guest = ownerLogin !== undefined && identity.login.toLowerCase() !== ownerLogin.toLowerCase();
  return {
    id: `tailnet:${identity.nodeId}:${principal}`,
    name: guest ? remoteFromName(base) : base,
    via: "tailnet" as const,
    machine: identity.node,
    login: identity.login,
    mayMessage: guest ? [] : ["*"],
  };
}

const gateways = new WeakMap<Broker, Gateway>();

export function gatewayOf(broker: Broker): Gateway {
  let gateway = gateways.get(broker);
  if (!gateway) {
    gateway = new Gateway(broker);
    gateways.set(broker, gateway);
  }
  return gateway;
}

export async function stopGateway(broker: Broker): Promise<void> {
  const gateway = gateways.get(broker);
  if (gateway) await gateway.stop();
  gateways.delete(broker);
}

export async function uninstallGateway(broker: Broker): Promise<{ stopped: StopSummary; disabled: number; archive: string }> {
  const gateway = gatewayOf(broker);
  const stopped = await gateway.shutdown("uninstall");
  const disabled = disableGatewayState(gateway.state);
  const archive = archiveGatewayState(broker.store.db, join(stateDir(), "backups"));
  await gateway.reconcile();
  return { stopped, disabled, archive };
}
