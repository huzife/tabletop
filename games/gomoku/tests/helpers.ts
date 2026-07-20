import { seatIdSchema, type SeatId } from "@tabletop/game-sdk";
import {
  createTestActionContextV1,
  createTestCreateMatchContextV1,
  createTestDeadlineContextV1,
  createTestProjectionContextV1,
  createTestSystemEventContextV1,
  FakeGameClockV1,
  SequenceGameRandomV1,
} from "@tabletop/game-sdk/testing";

import { createGomokuMatch } from "../server/engine.js";
import type { GomokuMatchState } from "../server/state.js";
import type { GomokuSettings } from "../shared/settings.js";

export const seat1 = seatIdSchema.parse("seat-1");
export const seat2 = seatIdSchema.parse("seat-2");

export const defaultSettings: GomokuSettings = {
  rule: "freestyle",
  timerEnabled: false,
  totalTimeMinutes: 10,
  moveTimeSeconds: 60,
};

export function createState(
  settings: Partial<GomokuSettings> = {},
  options: {
    readonly firstController?: "human" | "bot";
    readonly secondController?: "human" | "bot";
    readonly now?: number;
  } = {},
): GomokuMatchState {
  const clock = new FakeGameClockV1(options.now ?? 0);
  return createGomokuMatch(
    createTestCreateMatchContextV1({
      seats: [
        {
          seatId: seat1,
          controller:
            options.firstController === "bot"
              ? { kind: "bot", profileId: "normal" }
              : { kind: "human" },
        },
        {
          seatId: seat2,
          controller:
            options.secondController === "bot"
              ? { kind: "bot", profileId: "normal" }
              : { kind: "human" },
        },
      ],
      clock,
      random: new SequenceGameRandomV1([0]),
    }),
    { ...defaultSettings, ...settings },
  );
}

export function actionContext(seatId: SeatId, now = 0, revision = 0) {
  return createTestActionContextV1({
    actor: { kind: "human", seatId },
    receivedAtMonotonicMs: now,
    revision,
    clock: new FakeGameClockV1(now),
  });
}

export function projectionContext(now = 0, revision = 0) {
  return createTestProjectionContextV1({
    revision,
    clock: new FakeGameClockV1(now),
  });
}

export function deadlineContext(now: number, revision = 0) {
  return createTestDeadlineContextV1({
    firedAtMonotonicMs: now,
    revision,
    clock: new FakeGameClockV1(now),
  });
}

export function systemContext(now: number, revision = 0) {
  return createTestSystemEventContextV1({
    revision,
    clock: new FakeGameClockV1(now),
  });
}

export function appliedState<TState>(transition: {
  readonly kind: "noop" | "applied";
  readonly state: TState;
}): TState {
  if (transition.kind !== "applied") {
    throw new Error("expected an applied transition");
  }
  return transition.state;
}
