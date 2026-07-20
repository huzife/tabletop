export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

interface WindowEntry {
  timestamps: number[];
  touchedAt: number;
}

export class SlidingWindowRateLimiter {
  readonly #entries = new Map<string, WindowEntry>();
  readonly #limit: number;
  readonly #maxKeys: number;
  readonly #windowMs: number;

  constructor(options: { limit: number; maxKeys?: number; windowMs: number }) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new RangeError("Rate limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
      throw new RangeError("Rate-limit window must be a positive safe integer");
    }

    this.#limit = options.limit;
    this.#maxKeys = options.maxKeys ?? 10_000;
    this.#windowMs = options.windowMs;
  }

  consume(key: string, now = Date.now()): RateLimitResult {
    this.#evictIfNeeded(now);
    const threshold = now - this.#windowMs;
    const existing = this.#entries.get(key);
    const timestamps = existing?.timestamps.filter((timestamp) => timestamp > threshold) ?? [];

    if (timestamps.length >= this.#limit) {
      const oldest = timestamps[0] ?? now;
      this.#entries.set(key, { timestamps, touchedAt: now });
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, oldest + this.#windowMs - now),
      };
    }

    timestamps.push(now);
    this.#entries.set(key, { timestamps, touchedAt: now });
    return {
      allowed: true,
      remaining: this.#limit - timestamps.length,
      retryAfterMs: 0,
    };
  }

  #evictIfNeeded(now: number): void {
    if (this.#entries.size < this.#maxKeys) {
      return;
    }

    const expiredBefore = now - this.#windowMs;
    for (const [key, entry] of this.#entries) {
      if (entry.touchedAt <= expiredBefore) {
        this.#entries.delete(key);
      }
    }

    if (this.#entries.size < this.#maxKeys) {
      return;
    }

    const oldestKey = [...this.#entries.entries()].reduce((oldest, current) =>
      current[1].touchedAt < oldest[1].touchedAt ? current : oldest,
    )[0];
    this.#entries.delete(oldestKey);
  }
}
