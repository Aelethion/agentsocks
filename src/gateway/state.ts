import { createHash, randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Store } from "../store.ts";

export type Via = "tailnet" | "token" | "oauth" | "api";

export interface PeerRow {
  id: string;
  thread_id: string;
  name: string;
  via: Via;
  machine: string | null;
  login: string | null;
  may_message: string;
  detail: string;
  created_at: number;
  last_seen: number | null;
  disabled: number;
}

export interface HostRow {
  host: string;
  allowed: number;
  linked: number;
  url: string | null;
  created_at: number;
}

export type NewPeer = Omit<PeerRow, "created_at" | "last_seen" | "disabled"> & Partial<Pick<PeerRow, "created_at" | "last_seen" | "disabled">>;

export const ALLOW_ALL = "*";

export const threadIdFor = (peerId: string): string => `r-${createHash("sha256").update(peerId).digest("hex").slice(0, 24)}`;

export function parseAllow(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export interface AllowTarget {
  name: string;
  ref?: string | null;
  session?: string | null;
}

export function normalizeAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1).trim();
  return trimmed;
}

export function mayMessage(allow: readonly string[], target: string | AllowTarget): boolean {
  const wanted = new Set<string>();
  const want = (value: string | null | undefined): void => {
    const norm = (value ?? "").trim().toLowerCase();
    if (norm) wanted.add(norm);
  };
  if (typeof target === "string") want(target);
  else {
    want(target.name);
    want(target.ref);
    want(target.session);
  }
  return allow.some((entry) => {
    if (entry === ALLOW_ALL) return true;
    const norm = normalizeAllowEntry(entry).toLowerCase();
    return norm !== "" && wanted.has(norm);
  });
}

export class GatewayState {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  setting(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM gateway_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO gateway_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM gateway_settings WHERE key = ?").run(key);
  }

  getPeer(id: string): PeerRow | undefined {
    return this.db.prepare("SELECT * FROM gateway_peers WHERE id = ?").get(id) as PeerRow | undefined;
  }

  peerByThread(threadId: string | null | undefined): PeerRow | undefined {
    if (!threadId) return undefined;
    return this.db.prepare("SELECT * FROM gateway_peers WHERE thread_id = ?").get(threadId) as PeerRow | undefined;
  }

  peerByName(name: string): PeerRow | undefined {
    return this.db.prepare("SELECT * FROM gateway_peers WHERE lower(name) = lower(?)").get(name) as PeerRow | undefined;
  }

  listPeers(): PeerRow[] {
    return this.db.prepare("SELECT * FROM gateway_peers ORDER BY created_at ASC, id ASC").all() as unknown as PeerRow[];
  }

  insertPeer(peer: NewPeer, now = Date.now()): PeerRow {
    this.db
      .prepare("INSERT INTO gateway_peers (id, thread_id, name, via, machine, login, may_message, detail, created_at, last_seen, disabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(peer.id, peer.thread_id, peer.name, peer.via, peer.machine, peer.login, peer.may_message, peer.detail, peer.created_at ?? now, peer.last_seen ?? null, peer.disabled ?? 0);
    return this.getPeer(peer.id)!;
  }

  updatePeer(id: string, fields: Partial<Omit<PeerRow, "id" | "thread_id" | "created_at">>): void {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    this.db.prepare(`UPDATE gateway_peers SET ${sets} WHERE id = ?`).run(...(entries.map(([, v]) => v) as SQLInputValue[]), id);
  }

  deletePeer(id: string): void {
    this.db.prepare("DELETE FROM gateway_peers WHERE id = ?").run(id);
  }

  host(host: string): HostRow | undefined {
    return this.db.prepare("SELECT * FROM gateway_hosts WHERE host = ?").get(host.toLowerCase()) as HostRow | undefined;
  }

  hosts(): HostRow[] {
    return this.db.prepare("SELECT * FROM gateway_hosts ORDER BY host ASC").all() as unknown as HostRow[];
  }

  saveHost(host: string, fields: Partial<Pick<HostRow, "allowed" | "linked" | "url">>, now = Date.now()): HostRow {
    const key = host.toLowerCase();
    const current = this.host(key);
    const next = { allowed: fields.allowed ?? current?.allowed ?? 0, linked: fields.linked ?? current?.linked ?? 0, url: fields.url === undefined ? (current?.url ?? null) : fields.url };
    if (!next.allowed && !next.linked) {
      this.db.prepare("DELETE FROM gateway_hosts WHERE host = ?").run(key);
      return { host: key, ...next, created_at: current?.created_at ?? now };
    }
    this.db
      .prepare("INSERT INTO gateway_hosts (host, allowed, linked, url, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(host) DO UPDATE SET allowed = excluded.allowed, linked = excluded.linked, url = excluded.url")
      .run(key, next.allowed, next.linked, next.url, current?.created_at ?? now);
    return this.host(key)!;
  }
}

const cache = new WeakMap<Store, GatewayState>();

export function gatewayState(store: Store): GatewayState {
  let state = cache.get(store);
  if (!state) {
    state = new GatewayState(store.db);
    cache.set(store, state);
  }
  return state;
}

export function randomLoopbackPort(): number {
  return randomInt(20000, 60000);
}

const ARCHIVE_TABLES = ["gateway_settings", "gateway_peers", "gateway_hosts", "gateway_tokens", "gateway_oauth_clients", "gateway_oauth_codes", "gateway_oauth_tokens", "gateway_pairings", "gateway_push"];

export function archiveGatewayState(db: DatabaseSync, dir: string, now = Date.now()): string {
  const dump: Record<string, unknown> = { exportedAt: now };
  for (const table of ARCHIVE_TABLES) {
    try {
      dump[table] = db.prepare(`SELECT * FROM ${table}`).all();
    } catch {
      dump[table] = [];
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `gateway-state-${new Date(now).toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, JSON.stringify(dump, null, 2), { mode: 0o600 });
  return path;
}

export function disableGatewayState(state: GatewayState, now = Date.now()): number {
  let disabled = 0;
  for (const peer of state.listPeers()) {
    if (!peer.disabled) {
      state.updatePeer(peer.id, { disabled: 1 });
      state.db.prepare("UPDATE gateway_oauth_tokens SET revoked_at = ? WHERE peer_id = ? AND revoked_at IS NULL").run(now, peer.id);
      state.db.prepare("UPDATE gateway_tokens SET revoked_at = ? WHERE peer_id = ? AND revoked_at IS NULL").run(now, peer.id);
      disabled++;
    }
  }
  state.db.prepare("DELETE FROM gateway_pairings WHERE used_at IS NULL").run();
  state.db.prepare("DELETE FROM gateway_oauth_codes WHERE used_at IS NULL").run();
  for (const key of ["private", "public"]) {
    const raw = state.setting(key);
    if (!raw) continue;
    try {
      state.setSetting(key, JSON.stringify({ ...(JSON.parse(raw) as Record<string, unknown>), enabled: false }));
    } catch {}
  }
  return disabled;
}
