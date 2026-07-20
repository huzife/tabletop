import { describe, expect, it } from "vitest";

import { SlidingWindowRateLimiter } from "./rate-limiter.js";

describe("SlidingWindowRateLimiter", () => {
  it("enforces and then releases a sliding window", () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 5_000 });

    expect(limiter.consume("session", 1_000)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume("session", 2_000)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume("session", 3_000)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 3_000,
    });
    expect(limiter.consume("session", 6_001)).toMatchObject({ allowed: true, remaining: 0 });
  });
});
