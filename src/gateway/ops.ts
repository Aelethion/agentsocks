import { audit } from "../audit.ts";
import { listPeers } from "../peers.ts";
import type { Broker } from "../broker.ts";
import type { OpRequest, OpTable } from "../brokerops/types.ts";
import { listClaudeSessions } from "../claude.ts";
import { killSwitchOn } from "../paths.ts";
import { cloudflaredCommand, funnelCommand, funnelOffCommand, render, runCommand, serveCommand, serveOffCommand } from "./expose.ts";
import { PROVIDERS, apiKeyOf, apiPeerId, checkBaseUrl, detailOf, displayName, type ApiDetail } from "./apipeer.ts";
import { linkUrl, proxyPrefix } from "./federation.ts";
import { OAuthStore } from "./oauth.ts";
import { dropSubscriptionsForPeer } from "./push.ts";
import { isRemoteThread } from "./policy.ts";
import { ensurePeer, listRemotePeers, uniqueName } from "./remote.ts";
import { gatewayOf, uninstallGateway, type Gateway } from "./runtime.ts";
import { normalizeAllowEntry, parseAllow } from "./state.ts";
import { Tokens, allowEntryFor, assertPeerNameUsable } from "./tokens.ts";

function liveLocalNames(broker: Broker): string[] {
  const threads = broker.store.listThreads().filter((t) => !isRemoteThread(broker, t.thread_id)).map((t) => t.name);
  let sessions: string[] = [];
  try {
    sessions = listClaudeSessions().map((s) => s.name);
  } catch {
    sessions = [];
  }
  return [...threads, ...sessions];
}

const PEER_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,47}$/;

function peerName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!PEER_NAME.test(name)) throw new Error("a peer name is 1 to 48 letters, digits, spaces and . _ ( ) -");
  return name;
}

function allowList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim() || v.length > 64)) throw new Error("--may-message takes peer names");
  return [...new Set(value.map((v: string) => v.trim()))];
}

async function resolveAllowEntries(value: unknown): Promise<string[]> {
  const entries = allowList(value);
  if (entries.length === 0) return entries;
  const live = await listPeers({}).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    const norm = normalizeAllowEntry(entry);
    const lower = norm.toLowerCase();
    if (norm === "*" || norm === "") {
      out.push(norm === "" ? entry : norm);
      continue;
    }
    const identity = live.find((p) => p.session !== undefined && (p.session === norm || p.session.toLowerCase() === lower)) ?? live.find((p) => p.ref.toLowerCase() === lower);
    if (identity) {
      out.push(allowEntryFor({ name: norm, ref: identity.ref, ...(identity.session === undefined ? {} : { session: identity.session }) }));
      continue;
    }
    const named = live.filter((p) => p.name.toLowerCase() === lower);
    if (named.length > 1) throw new Error(`"${entry}" names ${named.length} live sessions; list_peers shows the ref in brackets, use that instead`);
    out.push(norm);
  }
  return [...new Set(out)];
}

export function grants(gateway: Gateway) {
  const db = gateway.broker.store.db;
  const tokens = new Tokens(db).list().map((t) => ({ id: t.id, label: t.label, kind: "token" as const, createdAt: t.created_at, lastUsedAt: t.last_used_at, revoked: t.revoked_at !== null }));
  const oauth = new OAuthStore(db).families().map((f) => ({
    id: f.family,
    label: `${gateway.state.getPeer(f.peer_id)?.name ?? f.peer_id} (ChatGPT-style OAuth grant)`,
    kind: "oauth" as const,
    createdAt: f.created,
    lastUsedAt: null,
    revoked: Number(f.live) === 0,
  }));
  return [...tokens, ...oauth];
}

function portOf(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) throw new Error("the port must be a whole number from 0 to 65535");
  return value;
}

export function statusReport(gateway: Gateway) {
  const priv = gateway.privateSettings();
  const pub = gateway.publicSettings();
  const [privateListener, publicListener] = gateway.listeners();
  const privatePort = privateListener?.port ?? priv.port;
  const publicPort = publicListener?.port ?? pub.port;
  const sourceCheck = gateway.source.getSourceVerdict();
  return {
    killSwitch: killSwitchOn(),
    requests: gateway.requests,
    lastActivity: gateway.lastActivity,
    sourceCheck,
    private: { ...priv, ...privateListener, configuredPort: priv.port, sourceCheck, serveCommand: render(serveCommand(privatePort)), serveOffCommand: render(serveOffCommand(privatePort)) },
    public: {
      ...pub,
      ...publicListener,
      configuredPort: pub.port,
      command: render(pub.via === "funnel" ? funnelCommand(publicPort) : cloudflaredCommand(publicPort)),
      offCommand: pub.via === "funnel" ? render(funnelOffCommand(publicPort)) : null,
    },
    users: gateway.allowedLogins(),
    tokens: grants(gateway).filter((t) => !t.revoked),
    hosts: gateway.state.hosts().map((h) => ({ host: h.host, allowed: h.allowed === 1, linked: h.linked === 1, url: h.url, ...gateway.federation.statuses().find((l) => l.host === h.host) })),
    peers: gateway.state.listPeers().filter((p) => p.disabled === 0).map((p) => ({ name: p.name, via: p.via, machine: p.machine, login: p.login, mayMessage: parseAllow(p.may_message), disabled: p.disabled === 1, lastSeen: p.last_seen })),
  };
}

async function changed(broker: Broker, mutate: (gateway: Gateway) => void) {
  const gateway = gatewayOf(broker);
  mutate(gateway);
  await gateway.reconcile();
  return { result: statusReport(gateway) };
}

export const gatewayOps: OpTable = {
  list_remote_peers: async (broker) => ({ result: listRemotePeers(broker) }),
  gateway_status: async (broker) => ({ result: statusReport(gatewayOf(broker)) }),
  gateway_on: async (broker, req: OpRequest) => {
    if (killSwitchOn()) throw new Error("agentsocks is switched off on this machine (kill switch), so the gateway cannot start");
    return changed(broker, (gateway) => {
      gateway.resume();
      const now = gateway.privateSettings();
      gateway.savePrivate({ ...now, enabled: true, port: portOf(req.port, now.port) });
    });
  },
  gateway_off: async (broker) => {
    const gateway = gatewayOf(broker);
    const stopped = await gateway.shutdown("gateway off");
    await gateway.reconcile();
    return { result: { ...statusReport(gateway), stopped } };
  },
  gateway_uninstall: async (broker) => {
    const out = await uninstallGateway(broker);
    const gateway = gatewayOf(broker);
    return { result: { ...out, serveFailed: gateway.privateSettings().served, funnelFailed: gateway.publicSettings().exposed } };
  },
  gateway_served: async (broker, req) => {
    if (req.served === true && gatewayOf(broker).port("private") === null) throw new Error("the private listener is not running, so there is no port for tailscale serve to point at");
    return changed(broker, (gateway) => {
      gateway.savePrivate({ ...gateway.privateSettings(), served: req.served === true });
    });
  },
  gateway_public: async (broker, req) => {
    if (killSwitchOn()) throw new Error("agentsocks is switched off on this machine (kill switch), so the gateway cannot start");
    const via = req.via === "funnel" || req.via === "cloudflared" ? req.via : undefined;
    if (!via) throw new Error("--via must be funnel or cloudflared");
    const url = typeof req.url === "string" && req.url ? req.url : undefined;
    if (url && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(url)) throw new Error("--url must be the https address of the public listener, for example https://machine.tailnet.ts.net:8443");
    return changed(broker, (gateway) => {
      gateway.resume();
      const now = gateway.publicSettings();
      const nextUrl = url ? url.replace(/\/$/, "") : now.url;
      gateway.savePublic({ enabled: true, port: portOf(req.port, now.port), via, ...(nextUrl && { url: nextUrl }), ...(typeof req.exposed === "boolean" && { exposed: req.exposed }) });
    });
  },
  gateway_token_add: async (broker, req) => {
    const gateway = gatewayOf(broker);
    const name = peerName(req.name);
    if (gateway.state.peerByName(name)) throw new Error(`a remote peer named ${name} already exists; choose another name`);
    assertPeerNameUsable(name, liveLocalNames(broker));
    const made = new Tokens(broker.store.db).add(name);
    const mayMessage = await resolveAllowEntries(req.mayMessage);
    await ensurePeer(broker, { id: made.peerId, name, via: "token", mayMessage });
    return { result: { id: made.id, token: made.token, name, mayMessage } };
  },
  gateway_token_list: async (broker) => ({ result: { tokens: grants(gatewayOf(broker)) } }),
  gateway_token_revoke: async (broker, req) => {
    const gateway = gatewayOf(broker);
    const id = String(req.id ?? "");
    const tokens = new Tokens(broker.store.db);
    const token = tokens.get(id);
    if (token) {
      if (token.revoked_at !== null) throw new Error(`token ${id} was already revoked`);
      for (const row of tokens.list()) if (row.peer_id === token.peer_id && row.revoked_at === null) tokens.revoke(row.id);
      gateway.closePollsFor((peerId) => peerId === token.peer_id);
      dropSubscriptionsForPeer(gateway.state, token.peer_id);
      const peer = gateway.state.getPeer(token.peer_id);
      if (peer) gateway.state.updatePeer(peer.id, { disabled: 1, name: uniqueName(gateway.state, `${peer.name} (revoked ${id})`, peer.id) });
      return { result: { revoked: id } };
    }
    const oauth = new OAuthStore(broker.store.db);
    const family = oauth.families().find((f) => f.family === id);
    if (!family) throw new Error(`no token or grant ${id}`);
    oauth.revokeFamily(id);
    gateway.closePollsFor((peerId) => peerId === family.peer_id);
    const stillLive = oauth.families().some((f) => f.peer_id === family.peer_id && Number(f.live) > 0);
    if (!stillLive) {
      dropSubscriptionsForPeer(gateway.state, family.peer_id);
      gateway.state.updatePeer(family.peer_id, { disabled: 1 });
    }
    return { result: { revoked: id } };
  },
  gateway_may: async (broker, req) => {
    const gateway = gatewayOf(broker);
    const row = gateway.state.peerByName(String(req.peer ?? ""));
    if (!row || row.disabled || row.id.startsWith("fed:")) throw new Error(`no remote peer named ${String(req.peer)}; agentsocks gateway status lists them`);
    const mayMessage = await resolveAllowEntries(req.mayMessage);
    gateway.state.updatePeer(row.id, { may_message: JSON.stringify(mayMessage) });
    return { result: { peer: row.name, mayMessage } };
  },
  gateway_pair: async (broker, req) => {
    const name = peerName(req.name ?? "chatgpt");
    assertPeerNameUsable(name, liveLocalNames(broker));
    const mayMessage = await resolveAllowEntries(req.mayMessage);
    const redirectHost = typeof req.redirectHost === "string" && req.redirectHost.trim() ? req.redirectHost.trim().toLowerCase() : null;
    if (redirectHost && !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(redirectHost)) throw new Error("--redirect-host must be a host name such as chatgpt.com");
    const code = new OAuthStore(broker.store.db).createPairing(name, mayMessage, redirectHost);
    return { result: { code, name, mayMessage, redirectHost, expiresInMinutes: 10 } };
  },
  gateway_allow: async (broker, req) => {
    const gateway = gatewayOf(broker);
    const allowed = req.allowed !== false;
    if (typeof req.user === "string") {
      const login = req.user.trim().toLowerCase();
      if (!/^[^\s@]{1,64}(@[^\s@]{1,128})?$/.test(login)) throw new Error("give the tailnet login, for example someone@example.com");
      const rest = gateway.allowedLogins().filter((l) => l !== login);
      gateway.saveLogins(allowed ? [...rest, login] : rest);
      return { result: statusReport(gateway) };
    }
    const host = String(req.host ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(host)) throw new Error("give the machine's tailnet name, for example hetzner-lab");
    gateway.state.saveHost(host, { allowed: allowed ? 1 : 0 });
    return { result: statusReport(gateway) };
  },
  gateway_link: async (broker, req) => {
    if (killSwitchOn()) throw new Error("agentsocks is switched off on this machine (kill switch), so it cannot link");
    const gateway = gatewayOf(broker);
    const url = linkUrl(String(req.target ?? "").trim(), (await gateway.tailnet.self())?.dnsName);
    const { host, peers } = await gateway.federation.handshake(url);
    gateway.state.saveHost(host, { linked: 1, url });
    gateway.resume();
    await gateway.reconcile();
    return { result: { host, url, peers } };
  },
  gateway_unlink: async (broker, req) => {
    const gateway = gatewayOf(broker);
    const host = String(req.host ?? "").trim().toLowerCase();
    if (!gateway.state.host(host)?.linked) throw new Error(`${host} is not linked`);
    gateway.state.saveHost(host, { linked: 0, url: null });
    for (const peer of gateway.state.listPeers()) if (peer.id.startsWith(proxyPrefix(host))) gateway.state.updatePeer(peer.id, { disabled: 1 });
    await gateway.reconcile();
    return { result: { host } };
  },
  peer_api_add: async (broker, req) => {
    const gateway = gatewayOf(broker);
    const provider = req.provider === "xai" || req.provider === "openai" ? req.provider : undefined;
    if (!provider) throw new Error("--api must be xai or openai");
    const base = peerName(req.name);
    assertPeerNameUsable(base, liveLocalNames(broker));
    const name = displayName(base);
    const id = apiPeerId(base);
    const earlier = gateway.state.getPeer(id);
    if ((gateway.state.peerByName(name) && gateway.state.peerByName(name)?.id !== id) || (earlier && !earlier.disabled)) throw new Error(`a remote peer named ${name} already exists`);
    const mayMessage = await resolveAllowEntries(req.mayMessage);
    if (mayMessage.length === 0) throw new Error("say who it may message: --may-message <peer>... (or '*' for every session)");
    const calls = req.maxCallsPerHour === undefined ? 30 : Number(req.maxCallsPerHour);
    if (!Number.isInteger(calls) || calls < 1 || calls > 1000) throw new Error("--max-calls-per-hour must be a whole number from 1 to 1000");
    const detail: ApiDetail = {
      provider,
      model: typeof req.model === "string" && req.model.trim() ? req.model.trim().slice(0, 80) : PROVIDERS[provider].model,
      keyFile: typeof req.keyFile === "string" && req.keyFile ? req.keyFile : null,
      baseUrl: typeof req.baseUrl === "string" && req.baseUrl ? checkBaseUrl(req.baseUrl) : PROVIDERS[provider].base,
      maxCallsPerHour: calls,
    };
    if (!apiKeyOf(detail)) throw new Error(`no ${PROVIDERS[provider].variable} found: give --key-file <file> with a ${PROVIDERS[provider].variable}=... line in it`);
    if (earlier) gateway.state.updatePeer(id, { name, may_message: JSON.stringify(mayMessage), detail: JSON.stringify({ api: detail }), disabled: 0 });
    await ensurePeer(broker, { id, name, via: "api", mayMessage, detail: { api: detail } });
    gateway.resume();
    await gateway.reconcile();
    return { result: { name, provider, model: detail.model, baseUrl: detail.baseUrl, keyFile: detail.keyFile, mayMessage, maxCallsPerHour: calls } };
  },
  peer_api_remove: async (broker, req) => {
    const gateway = gatewayOf(broker);
    const row = gateway.state.getPeer(apiPeerId(peerName(req.name).replace(/ \(api\)$/, "")));
    if (!row || row.disabled) throw new Error(`no API peer named ${String(req.name)}`);
    gateway.state.updatePeer(row.id, { disabled: 1, name: uniqueName(gateway.state, `${row.name} (removed)`, row.id) });
    await gateway.reconcile();
    return { result: { removed: row.name } };
  },
  peer_api_list: async (broker) => ({
    result: {
      peers: gatewayOf(broker)
        .state.listPeers()
        .filter((p) => p.via === "api" && !p.disabled)
        .map((p) => ({ name: p.name, ...detailOf(p), keyFile: detailOf(p)?.keyFile ?? null, mayMessage: parseAllow(p.may_message), lastSeen: p.last_seen })),
    },
  }),
  gateway_public_off: async (broker) => {
    const gateway = gatewayOf(broker);
    await gateway.close("public");
    const { url: _url, ...rest } = gateway.publicSettings();
    if (rest.exposed && rest.via === "funnel") {
      if ((await runCommand(funnelOffCommand(rest.port))) === 0) gateway.savePublic({ ...rest, enabled: false, exposed: false });
      else {
        audit("gateway_funnel_off_failed", { surface: "public", port: rest.port, reason: "gateway public off" });
        gateway.savePublic({ ...rest, enabled: false });
      }
    } else gateway.savePublic({ ...rest, enabled: false, exposed: false });
    await gateway.reconcile();
    return { result: statusReport(gateway) };
  },
};
