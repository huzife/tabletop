import type { SeatId } from "@tabletop/game-sdk";

import {
  FINISH_PROGRESS,
  flightCrossingCellId,
  JUMP_DISTANCE,
  MAIN_PATH_LENGTH,
  type LudoDisplayStep,
  type PlaneId,
} from "../../shared/index.js";
import {
  cellIdForPlane,
  cellIdForProgress,
  enemyBlockadeAtProgress,
  enemyPlanesAtProgress,
  flightExitPathIndex,
  isFlightEntry,
  isJumpPathIndex,
  planesAtFlightCrossing,
  positionFromProgress,
  progressFromPosition,
} from "../board/index.js";
import { requirePlane, type LudoPlane, type LudoState } from "./state.js";

export function getLegalPlaneIds(
  state: Readonly<LudoState>,
  seatId: SeatId,
  roll: number,
): PlaneId[] {
  return state.planes
    .filter((plane) => plane.color === state.seats.find((seat) => seat.seatId === seatId)?.color)
    .filter((plane) => {
      if (plane.position.region === "FINISHED") return false;
      if (plane.position.region === "BASE") return roll === 5 || roll === 6;
      return true;
    })
    .map((plane) => plane.planeId);
}

export function resolvePlaneAction(
  state: LudoState,
  planeId: PlaneId,
  roll: number,
): LudoDisplayStep[] {
  const plane = requirePlane(state, planeId);
  if (plane.position.region === "BASE") return launchPlane(plane, roll);
  if (plane.position.region === "FINISHED") throw new RangeError("a finished plane cannot move");

  const steps: LudoDisplayStep[] = [];
  let progress = progressFromPosition(plane.position);
  let direction: 1 | -1 = 1;

  for (let used = 0; used < roll; used += 1) {
    if (direction === -1 && progress === -1) {
      direction = 1;
      steps.push({
        type: "bounce",
        planeId: plane.planeId,
        atCellId: cellIdForProgress(plane.color, progress),
        reason: "apron",
      });
    }

    const from = progress;
    const next = progress + direction;
    if (next < -1 || next > FINISH_PROGRESS) {
      throw new Error(`ludo movement escaped route bounds: ${next}`);
    }
    progress = next;
    const remaining = roll - used - 1;
    steps.push({
      type: "move",
      planeId: plane.planeId,
      fromCellId: cellIdForProgress(plane.color, from),
      toCellId: cellIdForProgress(plane.color, progress),
      direction: direction === 1 ? "forward" : "backward",
    });

    if (progress === FINISH_PROGRESS) {
      if (remaining === 0) {
        plane.position = { region: "FINISHED" };
        steps.push({
          type: "finish",
          planeId: plane.planeId,
          atCellId: cellIdForProgress(plane.color, progress),
        });
        return steps;
      }
      direction = -1;
      steps.push({
        type: "bounce",
        planeId: plane.planeId,
        atCellId: cellIdForProgress(plane.color, progress),
        reason: "finish",
      });
      continue;
    }

    if (remaining > 0 && enemyBlockadeAtProgress(state, plane, progress).length > 0) {
      direction = direction === 1 ? -1 : 1;
      steps.push({
        type: "bounce",
        planeId: plane.planeId,
        atCellId: cellIdForProgress(plane.color, progress),
        reason: "blockade",
      });
    }
  }

  plane.position = positionFromProgress(progress);
  settleCollision(state, plane, steps);
  if (!isPlaneInMainPath(plane)) return steps;

  let jumped = false;
  if (!isFlightEntry(plane.position.pathIndex)) {
    const firstJump = tryJump(state, plane, steps);
    jumped = firstJump.succeeded;
    if (!isPlaneInMainPath(plane)) return steps;
  }

  let flew = false;
  if (isFlightEntry(plane.position.pathIndex)) {
    const fromCellId = cellIdForPlane(plane);
    const crossingCellId = flightCrossingCellId(plane.color);
    steps.push({
      type: "fly",
      planeId: plane.planeId,
      fromCellId: requireCellId(fromCellId),
      toCellId: crossingCellId,
    });
    if (!settleFlightCrossingCollision(state, plane, crossingCellId, steps)) return steps;

    plane.position = { region: "MAIN_PATH", pathIndex: flightExitPathIndex() };
    steps.push({
      type: "fly",
      planeId: plane.planeId,
      fromCellId: crossingCellId,
      toCellId: requireCellId(cellIdForPlane(plane)),
    });
    flew = true;
    settleCollision(state, plane, steps);
  }

  if (flew && !jumped && isPlaneInMainPath(plane)) tryJump(state, plane, steps);
  return steps;
}

function launchPlane(plane: LudoPlane, roll: number): LudoDisplayStep[] {
  if (roll !== 5 && roll !== 6) throw new RangeError("a plane can launch only on five or six");
  const fromCellId = requireCellId(cellIdForPlane(plane));
  plane.position = { region: "APRON" };
  return [
    {
      type: "launch",
      planeId: plane.planeId,
      fromCellId,
      toCellId: requireCellId(cellIdForPlane(plane)),
    },
  ];
}

function settleCollision(state: LudoState, movingPlane: LudoPlane, steps: LudoDisplayStep[]): void {
  if (movingPlane.position.region !== "MAIN_PATH") return;
  const enemies = [...enemyPlanesAtProgress(state, movingPlane, movingPlane.position.pathIndex)];
  if (enemies.length === 0) return;

  settleEnemyPlanes(movingPlane, enemies, requireCellId(cellIdForPlane(movingPlane)), steps);
}

function settleFlightCrossingCollision(
  state: LudoState,
  movingPlane: LudoPlane,
  crossingCellId: string,
  steps: LudoDisplayStep[],
): boolean {
  const enemies = [...planesAtFlightCrossing(state, movingPlane.color)];
  if (enemies.length === 0) return true;
  return settleEnemyPlanes(movingPlane, enemies, crossingCellId, steps);
}

function settleEnemyPlanes(
  movingPlane: LudoPlane,
  enemies: readonly LudoPlane[],
  atCellId: string,
  steps: LudoDisplayStep[],
): boolean {
  const mutual = enemies.length >= 2;
  for (const enemy of enemies) enemy.position = { region: "BASE" };
  if (mutual) movingPlane.position = { region: "BASE" };
  steps.push({
    type: "capture",
    planeId: movingPlane.planeId,
    atCellId,
    capturedPlaneIds: enemies.map((plane) => plane.planeId),
    mutual,
  });
  return !mutual;
}

function tryJump(
  state: LudoState,
  plane: LudoPlane,
  steps: LudoDisplayStep[],
): { readonly succeeded: boolean } {
  if (!isPlaneInMainPath(plane) || !isJumpPathIndex(plane.position.pathIndex)) {
    return { succeeded: false };
  }

  const fromPathIndex = plane.position.pathIndex;
  for (let offset = 1; offset < JUMP_DISTANCE; offset += 1) {
    const candidate = fromPathIndex + offset;
    if (enemyBlockadeAtProgress(state, plane, candidate).length > 0) {
      steps.push({
        type: "jump_cancelled",
        planeId: plane.planeId,
        fromCellId: requireCellId(cellIdForPlane(plane)),
        blockedCellId: cellIdForProgress(plane.color, candidate),
      });
      return { succeeded: false };
    }
  }

  const fromCellId = requireCellId(cellIdForPlane(plane));
  const destination = fromPathIndex + JUMP_DISTANCE;
  if (destination >= MAIN_PATH_LENGTH) return { succeeded: false };
  plane.position = { region: "MAIN_PATH", pathIndex: destination };
  steps.push({
    type: "jump",
    planeId: plane.planeId,
    fromCellId,
    toCellId: requireCellId(cellIdForPlane(plane)),
  });
  settleCollision(state, plane, steps);
  return { succeeded: true };
}

function isPlaneInMainPath(
  plane: LudoPlane,
): plane is LudoPlane & { position: { region: "MAIN_PATH"; pathIndex: number } } {
  return plane.position.region === "MAIN_PATH";
}

function requireCellId(value: string | null): string {
  if (value === null) throw new Error("expected plane to occupy a board cell");
  return value;
}
