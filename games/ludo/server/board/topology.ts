import type { SeatId } from "@tabletop/game-sdk";

import {
  FINISH_PROGRESS,
  FLIGHT_CROSSING_COLORS,
  FLIGHT_CROSSING_HOME_PATH_INDEX,
  FLIGHT_ENTRY_PATH_INDEX,
  FLIGHT_EXIT_PATH_INDEX,
  globalMainIndex,
  homeCellId,
  JUMP_PATH_INDICES,
  LUDO_COLORS_CLOCKWISE,
  LUDO_SEAT_IDS,
  mainCellId,
  MAIN_PATH_LENGTH,
  MAIN_RING_LENGTH,
  type LudoColor,
  type PlanePosition,
} from "../../shared/index.js";
import type { LudoPlane, LudoState } from "../rules/state.js";

export function colorForSeatId(seatId: SeatId): LudoColor {
  const color = LUDO_COLORS_CLOCKWISE.find((candidate) => LUDO_SEAT_IDS[candidate] === seatId);
  if (color === undefined) throw new RangeError(`unknown ludo seat id: ${seatId}`);
  return color;
}

export function seatIdForColor(color: LudoColor): SeatId {
  return LUDO_SEAT_IDS[color];
}

export function progressFromPosition(position: PlanePosition): number {
  switch (position.region) {
    case "APRON":
      return -1;
    case "MAIN_PATH":
      return position.pathIndex;
    case "HOME_PATH":
      return MAIN_PATH_LENGTH + position.pathIndex;
    case "FINISHED":
      return FINISH_PROGRESS;
    case "BASE":
      throw new RangeError("a base plane has no route progress");
  }
}

export function positionFromProgress(progress: number): PlanePosition {
  if (progress === -1) return { region: "APRON" };
  if (progress >= 0 && progress < MAIN_PATH_LENGTH) {
    return { region: "MAIN_PATH", pathIndex: progress };
  }
  if (progress >= MAIN_PATH_LENGTH && progress < FINISH_PROGRESS) {
    return { region: "HOME_PATH", pathIndex: progress - MAIN_PATH_LENGTH };
  }
  if (progress === FINISH_PROGRESS) return { region: "FINISHED" };
  throw new RangeError(`invalid ludo route progress: ${progress}`);
}

export function cellIdForProgress(color: LudoColor, progress: number): string {
  if (progress === -1) return `apron-${color}`;
  if (progress >= 0 && progress < MAIN_PATH_LENGTH) return mainCellId(color, progress);
  if (progress >= MAIN_PATH_LENGTH && progress <= FINISH_PROGRESS) {
    return homeCellId(color, progress - MAIN_PATH_LENGTH);
  }
  throw new RangeError(`invalid ludo route progress: ${progress}`);
}

export function cellIdForPlane(plane: Readonly<LudoPlane>): string | null {
  switch (plane.position.region) {
    case "BASE":
      return `base-${plane.color}-${plane.number}`;
    case "APRON":
      return `apron-${plane.color}`;
    case "MAIN_PATH":
      return mainCellId(plane.color, plane.position.pathIndex);
    case "HOME_PATH":
      return homeCellId(plane.color, plane.position.pathIndex);
    case "FINISHED":
      return null;
  }
}

export function planesOnMainCell(
  state: Readonly<LudoState>,
  globalIndex: number,
  excludedPlaneId?: string,
): readonly LudoPlane[] {
  return state.planes.filter(
    (plane) =>
      plane.planeId !== excludedPlaneId &&
      plane.position.region === "MAIN_PATH" &&
      globalMainIndex(plane.color, plane.position.pathIndex) === globalIndex % MAIN_RING_LENGTH,
  );
}

export function enemyPlanesAtProgress(
  state: Readonly<LudoState>,
  movingPlane: Readonly<LudoPlane>,
  progress: number,
): readonly LudoPlane[] {
  if (progress < 0 || progress >= MAIN_PATH_LENGTH) return [];
  return planesOnMainCell(
    state,
    globalMainIndex(movingPlane.color, progress),
    movingPlane.planeId,
  ).filter((plane) => plane.color !== movingPlane.color);
}

export function enemyBlockadeAtProgress(
  state: Readonly<LudoState>,
  movingPlane: Readonly<LudoPlane>,
  progress: number,
): readonly LudoPlane[] {
  const enemies = enemyPlanesAtProgress(state, movingPlane, progress);
  return enemies.length >= 2 ? enemies : [];
}

export function isJumpPathIndex(pathIndex: number): boolean {
  return JUMP_PATH_INDICES.includes(pathIndex) && pathIndex + 4 < MAIN_PATH_LENGTH;
}

export function isFlightEntry(pathIndex: number): boolean {
  return pathIndex === FLIGHT_ENTRY_PATH_INDEX;
}

export function flightExitPathIndex(): number {
  return FLIGHT_EXIT_PATH_INDEX;
}

export function planesAtFlightCrossing(
  state: Readonly<LudoState>,
  movingColor: LudoColor,
): readonly LudoPlane[] {
  const crossingColor = FLIGHT_CROSSING_COLORS[movingColor];
  return state.planes.filter(
    (plane) =>
      plane.color === crossingColor &&
      plane.position.region === "HOME_PATH" &&
      plane.position.pathIndex === FLIGHT_CROSSING_HOME_PATH_INDEX,
  );
}
