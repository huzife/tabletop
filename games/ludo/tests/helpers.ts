import { seatIdSchema, type SeatId } from "@tabletop/game-sdk";
import { createTestCreateMatchContextV1, SequenceGameRandomV1 } from "@tabletop/game-sdk/testing";

import {
  LUDO_COLORS_CLOCKWISE,
  LUDO_SEAT_IDS,
  MAIN_PATH_LENGTH,
  MAIN_RING_LENGTH,
  START_OFFSETS,
  type LudoColor,
  type PlaneId,
  type PlanePosition,
} from "../shared/index.js";
import { createLudoState, requirePlane, type LudoState } from "../server/index.js";

export function createTwoPlayerState(orderRandom: readonly number[] = [6, 1]): LudoState {
  return createLudoState(
    createTestCreateMatchContextV1({
      seats: [
        { seatId: LUDO_SEAT_IDS.red, controller: { kind: "human" } },
        { seatId: LUDO_SEAT_IDS.yellow, controller: { kind: "human" } },
      ],
      random: new SequenceGameRandomV1(orderRandom),
    }),
    { phaseTimeSeconds: 30 },
  );
}

export function createFourPlayerState(orderRandom: readonly number[] = [6, 5, 4, 3]): LudoState {
  return createLudoState(
    createTestCreateMatchContextV1({
      seats: LUDO_COLORS_CLOCKWISE.map((color) => ({
        seatId: LUDO_SEAT_IDS[color],
        controller: { kind: "human" as const },
      })),
      random: new SequenceGameRandomV1(orderRandom),
    }),
    { phaseTimeSeconds: 30 },
  );
}

export function setPlane(state: LudoState, planeId: PlaneId, position: PlanePosition): void {
  requirePlane(state, planeId).position = position;
}

export function setPlaneOnGlobalMain(
  state: LudoState,
  planeId: PlaneId,
  globalIndex: number,
): void {
  const plane = requirePlane(state, planeId);
  const pathIndex =
    (globalIndex - START_OFFSETS[plane.color] + MAIN_RING_LENGTH) % MAIN_RING_LENGTH;
  if (pathIndex >= MAIN_PATH_LENGTH)
    throw new RangeError("global cell is beyond the plane's home entry");
  plane.position = { region: "MAIN_PATH", pathIndex };
}

export function planeId(color: LudoColor, number: number): PlaneId {
  return `${color}-plane-${number}` as PlaneId;
}

export function seatId(value: string): SeatId {
  return seatIdSchema.parse(value);
}
