import type { SeatId } from "@tabletop/protocol";

import type { BilliardsBall, BilliardsBallKind } from "../../shared/view.js";
import type {
  BilliardsEndReason,
  BilliardsMatchState,
  BilliardsOutcome,
  BilliardsPlayerState,
} from "../state.js";

export function otherSeat(state: Readonly<BilliardsMatchState>, seatId: SeatId): SeatId {
  const other = state.seatIds.find((candidate) => candidate !== seatId);
  if (!other) throw new TypeError("Billiards match requires two distinct seats");
  return other;
}

export function ballById(
  balls: readonly BilliardsBall[],
  id: string | null,
): BilliardsBall | undefined {
  return id === null ? undefined : balls.find((ball) => ball.id === id);
}

export function newlyPottedBalls(
  state: Readonly<BilliardsMatchState>,
  ids: readonly string[],
): readonly BilliardsBall[] {
  const seen = new Set<string>();
  const result: BilliardsBall[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const ball = ballById(state.balls, id);
    if (ball && !ball.pocketed) result.push(ball);
  }
  return result;
}

export function markCueBallInHand(balls: readonly BilliardsBall[]): readonly BilliardsBall[] {
  return balls.map((ball) => (ball.kind === "cue" ? { ...ball, pocketed: true } : ball));
}

export function updatePlayer(
  players: readonly [BilliardsPlayerState, BilliardsPlayerState],
  seatId: SeatId,
  update: (player: Readonly<BilliardsPlayerState>) => BilliardsPlayerState,
): readonly [BilliardsPlayerState, BilliardsPlayerState] {
  return players.map((player) =>
    player.seatId === seatId ? update(player) : player,
  ) as unknown as readonly [BilliardsPlayerState, BilliardsPlayerState];
}

export function addScore(
  players: readonly [BilliardsPlayerState, BilliardsPlayerState],
  seatId: SeatId,
  points: number,
): readonly [BilliardsPlayerState, BilliardsPlayerState] {
  return updatePlayer(players, seatId, (player) => ({
    ...player,
    score: player.score + points,
  }));
}

export function scoreFor(players: readonly BilliardsPlayerState[], seatId: SeatId): number {
  return players.find((player) => player.seatId === seatId)?.score ?? 0;
}

export function endState(
  state: Readonly<BilliardsMatchState>,
  winnerSeatId: SeatId,
  reason: BilliardsEndReason,
): BilliardsMatchState {
  const outcome: BilliardsOutcome = { reason, winnerSeatId };
  return {
    ...state,
    activeSeatId: null,
    ballInHandZone: null,
    outcome,
    phase: "ended",
  };
}

export const SNOOKER_COLOR_VALUES: Readonly<
  Record<Exclude<BilliardsBallKind, "cue" | "solid" | "stripe" | "eight" | "red">, number>
> = {
  yellow: 2,
  green: 3,
  brown: 4,
  blue: 5,
  pink: 6,
  black: 7,
};

export const SNOOKER_COLORS_ASCENDING = [
  "yellow",
  "green",
  "brown",
  "blue",
  "pink",
  "black",
] as const;

export type SnookerColorKind = (typeof SNOOKER_COLORS_ASCENDING)[number];

export function isSnookerColor(kind: BilliardsBallKind): kind is SnookerColorKind {
  return SNOOKER_COLORS_ASCENDING.some((color) => color === kind);
}
