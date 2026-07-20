import { seatIdSchema } from "@tabletop/protocol";
import { describe, expect, it } from "vitest";

import { GameRuleError } from "./errors.js";
import { gameRoomDirectiveV1Schema, gameSystemEventV1Schema } from "./lifecycle.js";
import { FakeGameClockV1 } from "../testing/clock.js";
import { SequenceGameRandomV1 } from "../testing/random.js";

describe("SDK lifecycle primitives", () => {
  it("parses every generic system event and room directive", () => {
    const seatId = seatIdSchema.parse("seat-1");
    const events = [
      { type: "connection.lost", seatId, graceDeadlineMs: 30_000 },
      { type: "connection.restored", seatId },
      { type: "connection.grace_expired", seatId },
      { type: "seat.reclaim_requested", seatId },
      { type: "member.left", seatId },
    ];
    const directives = [
      { type: "seat.useFallbackController", seatId },
      { type: "seat.returnHumanControl", seatId },
      { type: "seat.release", seatId },
      { type: "seat.setReclaimable", seatId, reclaimable: true },
    ];
    for (const event of events) {
      expect(gameSystemEventV1Schema.safeParse(event).success).toBe(true);
    }
    for (const directive of directives) {
      expect(gameRoomDirectiveV1Schema.safeParse(directive).success).toBe(true);
    }
    expect(gameSystemEventV1Schema.safeParse({ type: "game-specific.event", seatId }).success).toBe(
      false,
    );
  });

  it("provides deterministic clock and random test doubles", () => {
    const clock = new FakeGameClockV1(100);
    clock.advance(25);
    expect(clock.monotonicMs()).toBe(125);

    const random = new SequenceGameRandomV1([
      { label: "die", value: 6 },
      { label: "choice", value: 1 },
    ]);
    expect(random.integer(1, 6, "die")).toBe(6);
    expect(random.pick(["a", "b"], "choice")).toBe("b");
    random.assertExhausted();
    expect(() => random.integer(1, 6, "extra")).toThrow(/exhausted/);
  });

  it("separates public rule details from internal messages", () => {
    const error = new GameRuleError("NOT_YOUR_TURN", { expected: "seat-2" }, "private diagnostic");
    expect(error.ruleCode).toBe("NOT_YOUR_TURN");
    expect(error.publicDetails).toEqual({ expected: "seat-2" });
    expect(error.message).toBe("private diagnostic");
    expect(() => new GameRuleError("invalid-code")).toThrow(TypeError);
  });
});
