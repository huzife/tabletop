import { describe, expect, it } from "vitest";

import { Semaphore, SemaphoreSaturatedError } from "./semaphore.js";

describe("Semaphore", () => {
  it("does not exceed the configured concurrency", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const operations = Array.from({ length: 4 }, async () =>
      semaphore.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peak).toBe(2);
    release?.();
    await Promise.all(operations);
  });

  it("rejects work beyond the bounded waiting queue", async () => {
    const semaphore = new Semaphore(1, 1);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = semaphore.run(() => gate);
    const waiting = semaphore.run(() => Promise.resolve());

    await expect(semaphore.run(() => Promise.resolve())).rejects.toBeInstanceOf(
      SemaphoreSaturatedError,
    );
    release?.();
    await Promise.all([active, waiting]);
  });
});
