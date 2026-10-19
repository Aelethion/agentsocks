import { createHash } from "node:crypto";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_WAKES_PER_HOUR = 6;
export const MAX_EXEMPT_WAKES_PER_HOUR = 20;
export const WAKE_PENDING_MS = 10 * 60_000;
export const STOP_STREAK_LIMIT = 3;
export const BUSY_STALE_MS = 15 * 60_000;
export const DIGEST_MAX_HOLD_MS = 15 * 60_000;
export const STALE_PEER_MS = 24 * 3_600_000;

const MAX_KEYS = 2000;

interface Bucket {
  tokens: number;
  at: number;
}

export class TokenBuckets {
  private buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSec: number;

  constructor(capacity: number, refillPerSec: number) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
  }

  take(key: string, now: number): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + ((now - bucket.at) / 1000) * this.refillPerSec);
    bucket.at = now;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > MAX_KEYS) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

export class InboundLimiter {
  private perSender = new TokenBuckets(30, 0.5);
  private perTarget = new TokenBuckets(60, 1);
  private receipts = new TokenBuckets(10, 0.1);

  check(sender: string, target: string, now = Date.now()): "ok" | "rate-limited" {
    if (!this.perSender.take(`${sender}\u0000${target}`, now)) return "rate-limited";
    if (!this.perTarget.take(target, now)) return "rate-limited";
    return "ok";
  }

  receipt(target: string, now = Date.now()): boolean {
    return this.receipts.take(target, now);
  }
}

export function bodyTooLarge(body: string): boolean {
  return Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export const normalizeBody = (body: string): string => body.replace(/\s+/g, " ").trim();

export const bodyHash = (body: string): string => sha256(normalizeBody(body));

const ADDRESS = /^uds:[A-Za-z0-9%:_/.\\-]{1,512}$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
export const THREAD_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const SESSION_ID = THREAD_ID;
export const RECEIPT_STATUSES = new Set(["held", "denied", "expired", "delivered", "refused", "dropped"]);

export const validAddress = (v: unknown): string | undefined => (typeof v === "string" && ADDRESS.test(v) ? v : undefined);
export const validId = (v: unknown): string | undefined => (typeof v === "string" && ID.test(v) ? v : undefined);

export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const printable = v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/["<>[\]`]/g, "").replace(/\s+/g, " ").trim();
  const chars = [...printable];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : printable;
}

export function squash(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
