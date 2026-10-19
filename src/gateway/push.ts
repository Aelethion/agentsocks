import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { Broker } from "../broker.ts";
import { audit } from "../audit.ts";
import { killSwitchOn } from "../paths.ts";
import { gatewayState, type GatewayState } from "./state.ts";

export const VAPID_SUBJECT = "https://github.com/Aelethion/agentsocks";
const JWT_LIFETIME_S = 12 * 3600;
const PUSH_TIMEOUT_MS = 5000;
const minPushGapMs = (): number => (process.env.AGENTSOCKS_PUSH_GAP_MS === undefined ? 15_000 : Number(process.env.AGENTSOCKS_PUSH_GAP_MS) || 0);
const MAX_ENDPOINT = 1024;
const KNOWN_PUSH_HOSTS = ["fcm.googleapis.com", ".push.apple.com", ".push.services.mozilla.com", ".notify.windows.com"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface Vapid {
  publicKey: string;
  privateKeyPem: string;
}

const b64 = (buf: Buffer | string): string => Buffer.from(buf).toString("base64url");

export function generateVapid(): Vapid {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  return { publicKey: b64(point), privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

export function vapidOf(state: GatewayState): Vapid {
  const stored = state.setting("vapid");
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<Vapid>;
      if (parsed.publicKey && parsed.privateKeyPem) return parsed as Vapid;
    } catch {}
  }
  const made = generateVapid();
  state.setSetting("vapid", JSON.stringify(made));
  return made;
}

export function vapidHeader(vapid: Vapid, endpoint: string, now = Date.now()): string {
  const header = b64(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + JWT_LIFETIME_S, sub: VAPID_SUBJECT }));
  const key: KeyObject = createPrivateKey(vapid.privateKeyPem);
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${vapid.publicKey}`;
}

export function publicKeyMatches(vapid: Vapid): boolean {
  const jwk = createPublicKey(createPrivateKey(vapid.privateKeyPem)).export({ format: "jwk" });
  return b64(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")])) === vapid.publicKey;
}

function extraHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.AGENTSOCKS_PUSH_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

export function acceptableEndpoint(raw: unknown, env: NodeJS.ProcessEnv = process.env): URL | undefined {
  if (typeof raw !== "string" || raw.length > MAX_ENDPOINT) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.hash) return undefined;
  const host = url.hostname.toLowerCase();
  const extra = extraHosts(env);
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(host) && extra.includes(host) ? url : undefined;
  if (url.protocol !== "https:") return undefined;
  const known = KNOWN_PUSH_HOSTS.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h));
  return known || extra.includes(host) ? url : undefined;
}

export interface Subscription {
  endpoint: string;
  peer_id: string;
  p256dh: string;
  auth: string;
}

export function subscriptionsOf(state: GatewayState, peerId: string): Subscription[] {
  return state.db.prepare("SELECT endpoint, peer_id, p256dh, auth FROM gateway_push WHERE peer_id = ?").all(peerId) as unknown as Subscription[];
}

const MAX_SUBSCRIPTIONS_PER_PEER = 10;

export function saveSubscription(state: GatewayState, peerId: string, endpoint: string, p256dh: string, auth: string, now = Date.now()): boolean {
  const existing = state.db.prepare("SELECT peer_id FROM gateway_push WHERE endpoint = ?").get(endpoint) as { peer_id: string } | undefined;
  if (existing && existing.peer_id !== peerId) return false;
  if (!existing && subscriptionsOf(state, peerId).length >= MAX_SUBSCRIPTIONS_PER_PEER) return false;
  state.db
    .prepare("INSERT INTO gateway_push (endpoint, peer_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth")
    .run(endpoint, peerId, p256dh, auth, now);
  return true;
}

export function dropSubscription(state: GatewayState, endpoint: string): void {
  state.db.prepare("DELETE FROM gateway_push WHERE endpoint = ?").run(endpoint);
}

export function dropSubscriptionsForPeer(state: GatewayState, peerId: string): number {
  return Number(state.db.prepare("DELETE FROM gateway_push WHERE peer_id = ?").run(peerId).changes);
}

export async function pushOnce(vapid: Vapid, endpoint: string, fetcher: typeof fetch = fetch): Promise<number> {
  const res = await fetcher(endpoint, {
    method: "POST",
    headers: { Authorization: vapidHeader(vapid, endpoint), TTL: "3600", Urgency: "normal" },
    redirect: "manual",
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  await res.body?.cancel();
  return res.status;
}

const notified = new WeakMap<Broker, Map<string, { level: number; at: number }>>();

export async function notifyAppPeers(broker: Broker, now = Date.now(), fetcher: typeof fetch = fetch): Promise<void> {
  if (killSwitchOn()) return;
  const state = gatewayState(broker.store);
  let seen = notified.get(broker);
  if (!seen) notified.set(broker, (seen = new Map()));
  let vapid: Vapid | undefined;
  for (const peer of state.listPeers()) {
    if (peer.disabled || !peer.id.endsWith(":app")) continue;
    const subscriptions = subscriptionsOf(state, peer.id);
    if (subscriptions.length === 0) continue;
    const unread = broker.store.queuedCount(peer.thread_id, false);
    const last = seen.get(peer.id) ?? { level: 0, at: 0 };
    if (unread === 0) {
      seen.set(peer.id, { level: 0, at: last.at });
      continue;
    }
    if (unread <= last.level || now - last.at < minPushGapMs()) continue;
    seen.set(peer.id, { level: unread, at: now });
    for (const sub of subscriptions) {
      if (!acceptableEndpoint(sub.endpoint)) {
        dropSubscription(state, sub.endpoint);
        continue;
      }
      try {
        vapid ??= vapidOf(state);
        const status = await pushOnce(vapid, sub.endpoint, fetcher);
        if (status === 404 || status === 410) dropSubscription(state, sub.endpoint);
        audit("push", { peer: peer.name, status });
      } catch (err) {
        audit("push_failed", { peer: peer.name, error: (err as Error).message });
      }
    }
  }
}
