import { GameRuleError } from "@tabletop/game-sdk/server";

import { tableSpecFor } from "../../shared/table.js";
import type { BilliardsBall } from "../../shared/view.js";
import type { BallInHandZone, BilliardsMatchState } from "../state.js";

const POSITION_EPSILON = 1e-9;

export type CuePlacementValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly ruleCode:
        | "CUE_OUT_OF_BOUNDS"
        | "CUE_OUTSIDE_D"
        | "CUE_OUTSIDE_BEHIND_LINE"
        | "CUE_IN_POCKET"
        | "CUE_OVERLAPS_BALL";
    };

export function checkCuePlacement(
  state: Readonly<BilliardsMatchState>,
  x: number,
  y: number,
  zone: BallInHandZone = state.ballInHandZone ?? "anywhere",
): CuePlacementValidation {
  const table = tableSpecFor(state.settings.mode);
  const radius = table.ballDiameter / 2;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < radius - POSITION_EPSILON ||
    x > table.width - radius + POSITION_EPSILON ||
    y < radius - POSITION_EPSILON ||
    y > table.height - radius + POSITION_EPSILON
  ) {
    return { ok: false, ruleCode: "CUE_OUT_OF_BOUNDS" };
  }

  if (zone === "d") {
    if (table.baulkLineX === null || table.dRadius === null) {
      return { ok: false, ruleCode: "CUE_OUTSIDE_D" };
    }
    const dx = x - table.baulkLineX;
    const dy = y - table.height / 2;
    if (
      x > table.baulkLineX + POSITION_EPSILON ||
      dx * dx + dy * dy > table.dRadius * table.dRadius + POSITION_EPSILON
    ) {
      return { ok: false, ruleCode: "CUE_OUTSIDE_D" };
    }
  }

  if (zone === "behind-line") {
    if (table.baulkLineX === null || x > table.baulkLineX + POSITION_EPSILON) {
      return { ok: false, ruleCode: "CUE_OUTSIDE_BEHIND_LINE" };
    }
  }

  if (
    table.pockets.some(
      ({ x: pocketX, y: pocketY, captureRadius }) =>
        Math.hypot(x - pocketX, y - pocketY) < captureRadius - POSITION_EPSILON,
    )
  ) {
    return { ok: false, ruleCode: "CUE_IN_POCKET" };
  }

  if (
    state.balls.some(
      (ball) =>
        ball.kind !== "cue" &&
        !ball.pocketed &&
        Math.hypot(x - ball.x, y - ball.y) < table.ballDiameter - POSITION_EPSILON,
    )
  ) {
    return { ok: false, ruleCode: "CUE_OVERLAPS_BALL" };
  }
  return { ok: true };
}

export function validateCuePlacement(
  state: Readonly<BilliardsMatchState>,
  x: number,
  y: number,
  zone: BallInHandZone = state.ballInHandZone ?? "anywhere",
): void {
  const result = checkCuePlacement(state, x, y, zone);
  if (!result.ok) throw new GameRuleError(result.ruleCode, { x, y, zone });
}

export function placeCueBall(
  balls: readonly BilliardsBall[],
  x: number,
  y: number,
): readonly BilliardsBall[] {
  let found = false;
  const placed = balls.map((ball) => {
    if (ball.kind !== "cue") return ball;
    found = true;
    return { ...ball, pocketed: false, rotation: 0, x, y };
  });
  if (!found) throw new TypeError("Billiards state is missing the cue ball");
  return placed;
}
