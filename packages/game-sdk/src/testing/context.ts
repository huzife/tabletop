import { matchIdSchema, seatIdSchema } from "@tabletop/protocol";

import type {
  ActionContextV1,
  CreateMatchContextV1,
  DeadlineContextV1,
  ProjectionContextV1,
  SystemEventContextV1,
} from "../server/context.js";
import { FakeGameClockV1 } from "./clock.js";
import { SequenceGameRandomV1 } from "./random.js";

export function createTestCreateMatchContextV1(
  overrides: Partial<CreateMatchContextV1> = {},
): CreateMatchContextV1 {
  return {
    matchId: matchIdSchema.parse("match-test"),
    seats: [
      {
        seatId: seatIdSchema.parse("seat-1"),
        controller: { kind: "human" },
      },
      {
        seatId: seatIdSchema.parse("seat-2"),
        controller: { kind: "human" },
      },
    ],
    clock: new FakeGameClockV1(),
    random: new SequenceGameRandomV1([]),
    ...overrides,
  };
}

export function createTestActionContextV1(
  overrides: Partial<ActionContextV1> = {},
): ActionContextV1 {
  return {
    matchId: matchIdSchema.parse("match-test"),
    revision: 0,
    actor: { kind: "human", seatId: seatIdSchema.parse("seat-1") },
    receivedAtMonotonicMs: 0,
    clock: new FakeGameClockV1(),
    random: new SequenceGameRandomV1([]),
    ...overrides,
  };
}

export function createTestProjectionContextV1(
  overrides: Partial<ProjectionContextV1> = {},
): ProjectionContextV1 {
  return {
    matchId: matchIdSchema.parse("match-test"),
    revision: 0,
    clock: new FakeGameClockV1(),
    ...overrides,
  };
}

export function createTestDeadlineContextV1(
  overrides: Partial<DeadlineContextV1> = {},
): DeadlineContextV1 {
  return {
    matchId: matchIdSchema.parse("match-test"),
    revision: 0,
    firedAtMonotonicMs: 0,
    clock: new FakeGameClockV1(),
    random: new SequenceGameRandomV1([]),
    ...overrides,
  };
}

export function createTestSystemEventContextV1(
  overrides: Partial<SystemEventContextV1> = {},
): SystemEventContextV1 {
  return {
    matchId: matchIdSchema.parse("match-test"),
    revision: 0,
    clock: new FakeGameClockV1(),
    random: new SequenceGameRandomV1([]),
    ...overrides,
  };
}
