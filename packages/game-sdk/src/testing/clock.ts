import type { GameClockV1 } from "../server/context.js";

export class FakeGameClockV1 implements GameClockV1 {
  #now: number;

  constructor(initialMonotonicMs = 0) {
    this.#now = validateTime(initialMonotonicMs);
  }

  monotonicMs(): number {
    return this.#now;
  }

  set(monotonicMs: number): void {
    this.#now = validateTime(monotonicMs);
  }

  advance(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new RangeError("durationMs must be finite and nonnegative");
    }
    this.#now = validateTime(this.#now + durationMs);
  }
}

function validateTime(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("monotonic time must be finite and nonnegative");
  }
  return value;
}
