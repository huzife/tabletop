import type {
  ActionContextV1,
  CreateMatchContextV1,
  DeadlineContextV1,
  GameDeadlineV1,
  GameTransitionV1,
  MatchSeatV1,
} from "@tabletop/game-sdk/server";
import { GameRuleError } from "@tabletop/game-sdk/server";
import type { SeatId } from "@tabletop/game-sdk";

import {
  LUDO_COLORS_CLOCKWISE,
  LUDO_SEAT_IDS,
  planeIdSchema,
  type LudoAction,
  type LudoColor,
  type LudoDisplayStep,
  type LudoSettings,
  type PlaneId,
} from "../../shared/index.js";
import { colorForSeatId } from "../board/index.js";
import { getLegalPlaneIds, resolvePlaneAction } from "./movement.js";
import {
  cloneLudoState,
  requirePlane,
  requireSeat,
  type LudoPlane,
  type LudoSeatState,
  type LudoState,
} from "./state.js";

export function createLudoState(
  context: CreateMatchContextV1,
  settings: Readonly<LudoSettings>,
): LudoState {
  validateMatchSeats(context.seats);
  const seats = LUDO_COLORS_CLOCKWISE.flatMap((color) => {
    const seat = context.seats.find((candidate) => candidate.seatId === LUDO_SEAT_IDS[color]);
    return seat === undefined ? [] : [createSeatState(seat, color)];
  });
  const { winner, rolls } = decideFirstSeat(
    context,
    seats.map((seat) => seat.seatId),
  );
  const seatOrder = clockwiseOrderFrom(winner, seats);
  const planes = seats.flatMap((seat) => createPlanes(seat.color));
  const deadlineNonce = 1;
  const actionDeadlineMs = context.clock.monotonicMs() + settings.phaseTimeSeconds * 1_000;
  const orderSteps: LudoDisplayStep[] = rolls.map((roll) => ({
    type: "roll",
    seatId: roll.seatId,
    value: roll.value,
    purpose: "order",
    round: roll.round,
  }));
  orderSteps.push({ type: "turn", seatId: winner });

  return {
    settings: { ...settings },
    phase: "waiting_roll",
    seats,
    seatOrder,
    currentSeatId: winner,
    sixStreak: 0,
    roll: null,
    planes,
    rankings: [],
    orderRolls: rolls,
    actionDeadlineMs,
    deadlineNonce,
    rollSequence: 0,
    lastSteps: orderSteps,
  };
}

export function applyLudoAction(
  context: ActionContextV1,
  state: Readonly<LudoState>,
  action: LudoAction,
): GameTransitionV1<LudoState, LudoDisplayStep> {
  assertActionBeforeDeadline(context, state);
  assertActorCanAct(context, state);
  const next = cloneLudoState(state);

  if (action.type === "roll") {
    if (next.phase !== "waiting_roll") throw ruleError("LUDO_NOT_WAITING_FOR_ROLL");
    const seatId = requireCurrentSeat(next);
    const value = context.random.integer(1, 6, `ludo.turn.${next.rollSequence + 1}.${seatId}.roll`);
    return transitionFrom(next, applyTurnRoll(next, value, context.clock.monotonicMs()));
  }

  if (next.phase !== "selecting_plane") throw ruleError("LUDO_NOT_SELECTING_PLANE");
  const seatId = requireCurrentSeat(next);
  const roll = requireCurrentRoll(next);
  const legal = getLegalPlaneIds(next, seatId, roll);
  if (!legal.includes(action.planeId)) {
    throw ruleError("LUDO_PLANE_NOT_LEGAL", { planeId: action.planeId });
  }
  return transitionFrom(
    next,
    applyPlaneSelection(next, action.planeId, context.clock.monotonicMs()),
  );
}

export function getLudoDeadlines(state: Readonly<LudoState>): readonly GameDeadlineV1[] {
  if (
    state.actionDeadlineMs === null ||
    state.currentSeatId === null ||
    (state.phase !== "waiting_roll" && state.phase !== "selecting_plane")
  ) {
    return [];
  }
  return [
    {
      deadlineId: deadlineId(state),
      dueAtMonotonicMs: state.actionDeadlineMs,
      payload: {
        phase: state.phase,
        seatId: state.currentSeatId,
      },
    },
  ];
}

export function applyLudoDeadline(
  context: DeadlineContextV1,
  state: Readonly<LudoState>,
  deadline: GameDeadlineV1,
): GameTransitionV1<LudoState, LudoDisplayStep> {
  if (
    state.actionDeadlineMs === null ||
    context.firedAtMonotonicMs < state.actionDeadlineMs ||
    deadline.deadlineId !== deadlineId(state)
  ) {
    return { kind: "noop", state: cloneLudoState(state) };
  }

  const next = cloneLudoState(state);
  if (next.phase === "waiting_roll") {
    const seatId = requireCurrentSeat(next);
    const value = context.random.integer(
      1,
      6,
      `ludo.turn.${next.rollSequence + 1}.${seatId}.timeout-roll`,
    );
    return transitionFrom(next, applyTurnRoll(next, value, context.clock.monotonicMs()));
  }

  if (next.phase === "selecting_plane") {
    const seatId = requireCurrentSeat(next);
    const roll = requireCurrentRoll(next);
    const legal = getLegalPlaneIds(next, seatId, roll);
    if (legal.length === 0) {
      const steps: LudoDisplayStep[] = [];
      completeAction(next, roll, steps, context.clock.monotonicMs());
      return transitionFrom(next, steps);
    }
    const planeId = context.random.pick(
      legal,
      `ludo.turn.${next.rollSequence}.${seatId}.timeout-plane`,
    );
    return transitionFrom(next, applyPlaneSelection(next, planeId, context.clock.monotonicMs()));
  }

  return { kind: "noop", state: next };
}

export function applyTurnRoll(state: LudoState, value: number, now: number): LudoDisplayStep[] {
  if (state.phase !== "waiting_roll") throw new Error("turn roll requires waiting_roll phase");
  if (!Number.isSafeInteger(value) || value < 1 || value > 6) {
    throw new RangeError(`invalid die value: ${value}`);
  }
  const seatId = requireCurrentSeat(state);
  state.rollSequence += 1;
  state.roll = value;
  state.sixStreak = value === 6 ? state.sixStreak + 1 : 0;
  const steps: LudoDisplayStep[] = [{ type: "roll", seatId, value, purpose: "turn", round: null }];

  if (state.sixStreak === 3) {
    const returnedPlaneIds = state.planes
      .filter((plane) => plane.color === requireSeat(state, seatId).color)
      .filter(
        (plane) =>
          plane.position.region === "APRON" ||
          plane.position.region === "MAIN_PATH" ||
          plane.position.region === "HOME_PATH",
      )
      .map((plane) => {
        plane.position = { region: "BASE" };
        return plane.planeId;
      });
    steps.push({ type: "three_sixes", seatId, returnedPlaneIds });
    state.sixStreak = 0;
    state.roll = null;
    advanceTurn(state, steps, now);
    state.lastSteps = steps;
    return steps;
  }

  const legal = getLegalPlaneIds(state, seatId, value);
  if (legal.length === 0) {
    completeAction(state, value, steps, now);
  } else {
    setActionPhase(state, "selecting_plane", now);
  }
  state.lastSteps = steps;
  return steps;
}

export function applyPlaneSelection(
  state: LudoState,
  planeId: PlaneId,
  now: number,
): LudoDisplayStep[] {
  const roll = requireCurrentRoll(state);
  state.phase = "resolving";
  state.actionDeadlineMs = null;
  const steps = resolvePlaneAction(state, planeId, roll);
  updateRankings(state, steps);
  if (state.currentSeatId !== null) completeAction(state, roll, steps, now);
  state.lastSteps = steps;
  return steps;
}

export function activeLudoSeatIds(state: Readonly<LudoState>): readonly SeatId[] {
  if (
    state.currentSeatId === null ||
    (state.phase !== "waiting_roll" && state.phase !== "selecting_plane")
  ) {
    return [];
  }
  return [state.currentSeatId];
}

function completeAction(
  state: LudoState,
  roll: number,
  steps: LudoDisplayStep[],
  now: number,
): void {
  state.roll = null;
  if (state.phase === "ended") return;
  const currentSeatId = requireCurrentSeat(state);
  const currentRanked = state.rankings.includes(currentSeatId);
  if (roll === 6 && !currentRanked) {
    setActionPhase(state, "waiting_roll", now);
    steps.push({ type: "turn", seatId: currentSeatId });
    return;
  }
  state.sixStreak = 0;
  advanceTurn(state, steps, now);
}

function advanceTurn(state: LudoState, steps: LudoDisplayStep[], now: number): void {
  const currentSeatId = requireCurrentSeat(state);
  const currentIndex = state.seatOrder.indexOf(currentSeatId);
  for (let offset = 1; offset <= state.seatOrder.length; offset += 1) {
    const candidate = state.seatOrder[(currentIndex + offset) % state.seatOrder.length];
    if (candidate !== undefined && !state.rankings.includes(candidate)) {
      state.currentSeatId = candidate;
      setActionPhase(state, "waiting_roll", now);
      steps.push({ type: "turn", seatId: candidate });
      return;
    }
  }
  endMatch(state);
}

function updateRankings(state: LudoState, steps: LudoDisplayStep[]): void {
  const currentSeatId = requireCurrentSeat(state);
  if (
    !state.rankings.includes(currentSeatId) &&
    planesForSeat(state, currentSeatId).every((plane) => plane.position.region === "FINISHED")
  ) {
    state.rankings.push(currentSeatId);
    steps.push({ type: "rank", seatId: currentSeatId, rank: state.rankings.length });
  }

  const remaining = state.seatOrder.filter((seatId) => !state.rankings.includes(seatId));
  if (remaining.length === 1 && state.rankings.length > 0) {
    const last = remaining[0];
    if (last !== undefined) {
      state.rankings.push(last);
      steps.push({ type: "rank", seatId: last, rank: state.rankings.length });
    }
    endMatch(state);
  } else if (remaining.length === 0) {
    endMatch(state);
  }
}

function endMatch(state: LudoState): void {
  state.phase = "ended";
  state.currentSeatId = null;
  state.roll = null;
  state.sixStreak = 0;
  state.actionDeadlineMs = null;
}

function setActionPhase(
  state: LudoState,
  phase: "waiting_roll" | "selecting_plane",
  now: number,
): void {
  state.phase = phase;
  state.deadlineNonce += 1;
  state.actionDeadlineMs = now + state.settings.phaseTimeSeconds * 1_000;
}

function transitionFrom(
  state: LudoState,
  events: readonly LudoDisplayStep[],
): GameTransitionV1<LudoState, LudoDisplayStep> {
  return {
    kind: "applied",
    state,
    events,
    ...(state.phase === "ended"
      ? {
          outcome: {
            kind: "completed" as const,
            publicSummary: { rankings: state.rankings },
          },
        }
      : {}),
  };
}

function assertActionBeforeDeadline(context: ActionContextV1, state: Readonly<LudoState>): void {
  if (state.actionDeadlineMs !== null && context.receivedAtMonotonicMs > state.actionDeadlineMs) {
    throw ruleError("LUDO_ACTION_AFTER_DEADLINE");
  }
}

function assertActorCanAct(context: ActionContextV1, state: Readonly<LudoState>): void {
  const currentSeatId = requireCurrentSeat(state);
  if (context.actor.seatId !== currentSeatId) throw ruleError("LUDO_NOT_YOUR_TURN");
  const seat = requireSeat(state, currentSeatId);
  const allowed =
    (context.actor.kind === "human" && seat.controller === "human") ||
    (context.actor.kind === "bot" && seat.controller === "bot") ||
    (context.actor.kind === "fallback" &&
      (seat.controller === "temporary_ai" ||
        seat.controller === "persistent_ai" ||
        context.actor.reason === "timeout"));
  if (!allowed) throw ruleError("LUDO_CONTROLLER_MISMATCH");
}

function validateMatchSeats(seats: readonly MatchSeatV1[]): void {
  if (seats.length < 2 || seats.length > 4) throw ruleError("LUDO_PLAYER_COUNT_INVALID");
  if (!seats.some((seat) => seat.controller.kind === "human")) {
    throw ruleError("LUDO_HUMAN_REQUIRED");
  }
  const ids = new Set<SeatId>();
  for (const seat of seats) {
    colorForSeatId(seat.seatId);
    if (ids.has(seat.seatId)) throw ruleError("LUDO_DUPLICATE_SEAT");
    ids.add(seat.seatId);
  }
}

function createSeatState(seat: MatchSeatV1, color: LudoColor): LudoSeatState {
  return {
    seatId: seat.seatId,
    color,
    controller: seat.controller.kind === "human" ? "human" : "bot",
    botProfileId: seat.controller.kind === "bot" ? seat.controller.profileId : null,
    reclaimable: false,
  };
}

function createPlanes(color: LudoColor): LudoPlane[] {
  return Array.from({ length: 4 }, (_, index) => ({
    planeId: planeIdSchema.parse(`${color}-plane-${index + 1}`),
    color,
    number: index + 1,
    position: { region: "BASE" as const },
  }));
}

function decideFirstSeat(context: CreateMatchContextV1, seatIds: readonly SeatId[]) {
  const rolls: Array<{ round: number; seatId: SeatId; value: number }> = [];
  let contenders = [...seatIds];
  let round = 1;
  for (;;) {
    const roundRolls = contenders.map((seatId) => ({
      round,
      seatId,
      value: context.random.integer(1, 6, `ludo.order.${round}.${seatId}`),
    }));
    rolls.push(...roundRolls);
    const highest = Math.max(...roundRolls.map((roll) => roll.value));
    contenders = roundRolls.filter((roll) => roll.value === highest).map((roll) => roll.seatId);
    if (contenders.length === 1) {
      const winner = contenders[0];
      if (winner === undefined) throw new Error("order decision produced no winner");
      return { winner, rolls };
    }
    round += 1;
    if (round > 1_000) throw new Error("order decision did not converge");
  }
}

function clockwiseOrderFrom(winner: SeatId, seats: readonly LudoSeatState[]): SeatId[] {
  const winnerColor = colorForSeatId(winner);
  const start = LUDO_COLORS_CLOCKWISE.indexOf(winnerColor);
  const occupied = new Set(seats.map((seat) => seat.seatId));
  return Array.from(
    { length: LUDO_COLORS_CLOCKWISE.length },
    (_, offset) => LUDO_COLORS_CLOCKWISE[(start + offset) % LUDO_COLORS_CLOCKWISE.length],
  ).flatMap((color) => {
    if (color === undefined) return [];
    const seatId = LUDO_SEAT_IDS[color];
    return occupied.has(seatId) ? [seatId] : [];
  });
}

function planesForSeat(state: Readonly<LudoState>, seatId: SeatId): readonly LudoPlane[] {
  const color = requireSeat(state, seatId).color;
  return state.planes.filter((plane) => plane.color === color);
}

function requireCurrentSeat(state: Readonly<LudoState>): SeatId {
  if (state.currentSeatId === null) throw ruleError("LUDO_MATCH_ENDED");
  return state.currentSeatId;
}

function requireCurrentRoll(state: Readonly<LudoState>): number {
  if (state.roll === null) throw new Error("current ludo roll is missing");
  return state.roll;
}

function deadlineId(state: Readonly<LudoState>): string {
  return `ludo:${state.deadlineNonce}:${state.phase}:${state.currentSeatId ?? "none"}`;
}

function ruleError(code: string, details: Record<string, string> = {}): GameRuleError {
  return new GameRuleError(code, details);
}
