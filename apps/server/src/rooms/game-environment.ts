import { randomInt } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { GameClockV1, GameRandomV1 } from "@tabletop/game-sdk/server";

export const systemGameClock: GameClockV1 = Object.freeze({
  monotonicMs: () => performance.now(),
});

export const secureGameRandom: GameRandomV1 = Object.freeze({
  integer(minInclusive: number, maxInclusive: number, _label: string) {
    if (
      !Number.isSafeInteger(minInclusive) ||
      !Number.isSafeInteger(maxInclusive) ||
      minInclusive > maxInclusive
    ) {
      throw new RangeError("random integer bounds are invalid");
    }
    return randomInt(minInclusive, maxInclusive + 1);
  },
  pick<T>(items: readonly T[], _label: string): T {
    if (items.length === 0) {
      throw new RangeError("cannot pick from an empty collection");
    }
    const selected = items[randomInt(0, items.length)];
    if (selected === undefined) {
      throw new Error("secure random selection failed");
    }
    return selected;
  },
});
