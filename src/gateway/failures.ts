const MAX_KEYS = 1000;

export class FailureWindow {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, number[]>();

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  private recent(key: string, now: number): number[] {
    const kept = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (kept.length > 0) this.hits.set(key, kept);
    else this.hits.delete(key);
    return kept;
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  record(key: string, now = Date.now()): void {
    const kept = this.recent(key, now);
    kept.push(now);
    this.hits.delete(key);
    this.hits.set(key, kept);
    if (this.hits.size > MAX_KEYS) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
  }

  retryAfterSeconds(key: string, now = Date.now()): number {
    const kept = this.recent(key, now);
    return kept.length === 0 ? 1 : Math.max(1, Math.ceil((kept[0]! + this.windowMs - now) / 1000));
  }
}
