import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface TokenRow {
  id: string;
  peer_id: string;
  label: string;
  salt: string;
  hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export const TOKEN_PREFIX = "agk_";
const TOKEN_SHAPE = /^agk_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

export const REMOTE_FROM_MARKER = " (remote)";
export const PHONE_FROM_MARKER = " (phone)";

export function markedFromName(base: string, marker: string): string {
  const name = base.trim();
  return name.toLowerCase().endsWith(marker.toLowerCase()) ? name : `${name}${marker}`;
}

export const remoteFromName = (base: string): string => markedFromName(base, REMOTE_FROM_MARKER);
export const phoneFromName = (base: string): string => markedFromName(base, PHONE_FROM_MARKER);

export function assertPeerNameUsable(baseName: string, liveLocalNames: readonly string[] = []): void {
  const name = baseName.trim();
  if (!name) throw new Error("name the peer: a peer name is 1 to 48 characters");
  if (name.includes("@")) throw new Error(`a peer name cannot contain "@": "${name}" would read as a linked session, so receivers could not tell them apart`);
  if (/[()]/.test(name)) throw new Error(`a peer name cannot contain brackets: receivers see a remote peer with a marker such as " (remote)" added, so a name carrying its own brackets could imitate another peer`);
  const clash = liveLocalNames.find((n) => n.trim().toLowerCase() === name.toLowerCase());
  if (clash !== undefined) throw new Error(`a local session is already named "${clash}": name the peer differently so receivers can tell them apart (they would see it as "${name} (remote)")`);
}

export function allowEntryFor(target: { name: string; ref?: string; session?: string }): string {
  return target.session ?? target.ref ?? target.name;
}
export const peerIdOf = (tokenId: string): string => `token:${tokenId}`;

const digest = (salt: string, secret: string): Buffer => createHash("sha256").update(`${salt}:${secret}`).digest();

export function mintToken(): { id: string; secret: string; token: string } {
  const id = randomBytes(4).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { id, secret, token: `${TOKEN_PREFIX}${id}_${secret}` };
}

export class Tokens {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  add(label: string, now = Date.now()): { id: string; peerId: string; token: string } {
    let minted = mintToken();
    while (this.get(minted.id)) minted = mintToken();
    const salt = randomBytes(16).toString("hex");
    this.db
      .prepare("INSERT INTO gateway_tokens (id, peer_id, label, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(minted.id, peerIdOf(minted.id), label, salt, digest(salt, minted.secret).toString("hex"), now);
    return { id: minted.id, peerId: peerIdOf(minted.id), token: minted.token };
  }

  get(id: string): TokenRow | undefined {
    return this.db.prepare("SELECT * FROM gateway_tokens WHERE id = ?").get(id) as TokenRow | undefined;
  }

  list(): TokenRow[] {
    return this.db.prepare("SELECT * FROM gateway_tokens ORDER BY created_at ASC").all() as unknown as TokenRow[];
  }

  verify(presented: string, now = Date.now()): TokenRow | undefined {
    const m = TOKEN_SHAPE.exec(presented);
    if (!m) return undefined;
    const row = this.get(m[1]!);
    const salt = row?.salt ?? "0".repeat(32);
    const want = Buffer.from(row?.hash ?? "0".repeat(64), "hex");
    const got = digest(salt, m[2]!);
    const same = want.length === got.length && timingSafeEqual(want, got);
    if (!row || !same || row.revoked_at !== null) return undefined;
    this.db.prepare("UPDATE gateway_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
    return row;
  }

  revoke(id: string, now = Date.now()): boolean {
    return Number(this.db.prepare("UPDATE gateway_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id).changes) > 0;
  }
}
