import type { SeatId } from "@tabletop/protocol";
import type { GameSystemEventV1 } from "@tabletop/game-sdk/server";
import { GameRuleError } from "@tabletop/game-sdk/server";

import {
  BilliardsCoreError,
  createBilliardsCoreMatch,
  getBilliardsTableSpec,
  reduceBilliardsCoreAction,
  simulateBilliardsShot,
} from "../physics/index.js";
import type { BilliardsAction } from "../shared/actions.js";
import type { BilliardsDisplayEvent, BilliardsView } from "../shared/view.js";
import type {
  BilliardsEndReason,
  BilliardsMatchState,
  BilliardsSimulationResult,
} from "./state.js";
import type {
  ActionContextV1,
  CreateMatchContextV1,
  DeadlineContextV1,
  ProjectionContextV1,
  SystemEventContextV1,
  ViewerV1,
} from "@tabletop/game-sdk/server";
import { billiardsSettings, type BilliardsSettings } from "../shared/settings.js";

export function createBilliardsMatch(
  context: Readonly<CreateMatchContextV1>,
  settings: Readonly<BilliardsSettings>,
): BilliardsMatchState {
  const seatIds = context.seats.map(({ seatId }) => seatId);
  if (
    (context.seats.length !== 1 && context.seats.length !== 2) ||
    new Set(seatIds).size !== context.seats.length ||
    context.seats.some(({ controller }) => controller.kind !== "human")
  ) {
    throw new GameRuleError("REQUIRES_ONE_OR_TWO_HUMANS");
  }
  const normalizedSettings = billiardsSettings.schema.parse(settings);
  return invokeRulesCore(() => createBilliardsCoreMatch(normalizedSettings, seatIds));
}

export function getBilliardsActiveSeatIds(state: Readonly<BilliardsMatchState>): readonly SeatId[] {
  return state.phase === "ended" || state.activeSeatId === null ? [] : [state.activeSeatId];
}

export function getBilliardsDeadlines(): readonly [] {
  return [];
}

export function handleBilliardsDeadline(
  _context: Readonly<DeadlineContextV1>,
  state: Readonly<BilliardsMatchState>,
): { readonly kind: "noop"; readonly state: Readonly<BilliardsMatchState> } {
  return { kind: "noop", state };
}

function requireCurrentHuman(
  context: Readonly<ActionContextV1>,
  state: Readonly<BilliardsMatchState>,
): SeatId {
  if (context.actor.kind !== "human") throw new GameRuleError("PLAYER_ONLY");
  if (!state.activeSeatId || context.actor.seatId !== state.activeSeatId) {
    throw new GameRuleError("NOT_YOUR_TURN");
  }
  return context.actor.seatId;
}

function outcomeSummary(state: Readonly<BilliardsMatchState>) {
  return {
    gameId: "billiards",
    mode: state.settings.mode,
    reason: state.outcome?.reason ?? null,
    scores: state.players.map(({ score, seatId }) => ({ score, seatId })),
    winnerSeatId: state.outcome?.winnerSeatId ?? null,
  };
}

function invokeRulesCore<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof BilliardsCoreError &&
      (error.kind === "rule" || error.kind === "invalid-input")
    ) {
      throw new GameRuleError(error.code);
    }
    throw error;
  }
}

function reduceRuleAction(
  state: Readonly<BilliardsMatchState>,
  actorSeatId: SeatId,
  action: BilliardsAction,
  options: {
    readonly decidingBlackChooserIndex?: number;
    readonly simulation?: Readonly<BilliardsSimulationResult>;
  } = {},
) {
  return invokeRulesCore(() =>
    reduceBilliardsCoreAction({
      action,
      actorSeatId,
      ...options,
      state,
    }),
  );
}

function transitionForRuleAction(
  state: Readonly<BilliardsMatchState>,
  actorSeatId: SeatId,
  action: BilliardsAction,
) {
  const resolution = reduceRuleAction(state, actorSeatId, action);
  const events: BilliardsDisplayEvent[] = [];
  if (resolution.state.outcome) {
    events.push({
      reason: resolution.state.outcome.reason,
      type: "billiards.match-ended",
      winnerSeatId: resolution.state.outcome.winnerSeatId,
    });
  }
  return {
    kind: "applied" as const,
    events,
    ...(resolution.state.outcome
      ? { outcome: { kind: "completed" as const, publicSummary: outcomeSummary(resolution.state) } }
      : {}),
    state: resolution.state,
  };
}

function transitionForShot(
  context: Readonly<ActionContextV1>,
  state: Readonly<BilliardsMatchState>,
  actorSeatId: SeatId,
  action: Extract<BilliardsAction, { type: "billiards.shoot" }>,
) {
  if (state.phase !== "aiming") throw new GameRuleError("PLACE_CUE_FIRST");
  const cue = state.balls.find((ball) => ball.kind === "cue");
  if (!cue || cue.pocketed) throw new GameRuleError("PLACE_CUE_FIRST");
  if (
    !state.practice &&
    state.settings.mode === "snooker" &&
    state.snookerOn === "color" &&
    action.shot.nominatedColor === null
  ) {
    throw new GameRuleError("COLOR_NOMINATION_REQUIRED");
  }

  const normalizedSettings = billiardsSettings.schema.parse(state.settings);
  const initialBalls = state.balls.map((ball) => ({ ...ball }));
  const simulation = simulateBilliardsShot({
    balls: initialBalls,
    clothRollingFriction: normalizedSettings.clothRollingFriction,
    clothSlidingFriction: normalizedSettings.clothSlidingFriction,
    mode: state.settings.mode,
    shot: action.shot,
  });
  let resolution = reduceRuleAction(state, actorSeatId, action, { simulation });
  if (
    resolution.state.phase === "decision" &&
    resolution.state.pendingDecision?.type === "deciding-black-choice"
  ) {
    const chooserSeatId = context.random.pick(
      state.seatIds,
      `billiards.snooker.deciding-black.${state.shotNumber + 1}.chooser`,
    );
    const chooserIndex = state.seatIds.indexOf(chooserSeatId);
    resolution = reduceRuleAction(state, actorSeatId, action, {
      decidingBlackChooserIndex: chooserIndex,
      simulation,
    });
  }
  const nextSeatId = resolution.state.activeSeatId;
  const shotEvent: BilliardsDisplayEvent = {
    clothRollingFriction: normalizedSettings.clothRollingFriction,
    clothSlidingFriction: normalizedSettings.clothSlidingFriction,
    durationMs: simulation.durationMs,
    foulCode: resolution.foulCode,
    initialBalls,
    mode: state.settings.mode,
    nextSeatId,
    points: resolution.points,
    pottedBallIds: [...simulation.pocketedBallIds],
    seatId: actorSeatId,
    shot: action.shot,
    shotNumber: resolution.state.shotNumber,
    simulationChecksum: simulation.checksum,
    simulationStateHash: simulation.stateHash,
    physicsVersion: simulation.physicsVersion,
    type: "billiards.shot",
  };
  const events: BilliardsDisplayEvent[] = [shotEvent];
  if (resolution.state.outcome) {
    events.push({
      reason: resolution.state.outcome.reason,
      type: "billiards.match-ended",
      winnerSeatId: resolution.state.outcome.winnerSeatId,
    });
  }
  return {
    kind: "applied" as const,
    events,
    ...(resolution.state.outcome
      ? { outcome: { kind: "completed" as const, publicSummary: outcomeSummary(resolution.state) } }
      : {}),
    state: resolution.state,
  };
}

export function handleBilliardsAction(
  context: Readonly<ActionContextV1>,
  state: Readonly<BilliardsMatchState>,
  action: BilliardsAction,
) {
  if (state.phase === "ended" || state.outcome !== null) throw new GameRuleError("MATCH_ENDED");
  if (action.type === "billiards.resign") {
    if (context.actor.kind !== "human" || !state.seatIds.includes(context.actor.seatId)) {
      throw new GameRuleError("PLAYER_ONLY");
    }
    return transitionForRuleAction(state, context.actor.seatId, action);
  }
  const actorSeatId = requireCurrentHuman(context, state);
  return action.type === "billiards.shoot"
    ? transitionForShot(context, state, actorSeatId, action)
    : transitionForRuleAction(state, actorSeatId, action);
}

export function handleBilliardsSystemEvent(
  _context: Readonly<SystemEventContextV1>,
  state: Readonly<BilliardsMatchState>,
  event: GameSystemEventV1,
) {
  if (state.phase === "ended" || !state.seatIds.includes(event.seatId)) {
    return { kind: "noop" as const, state };
  }
  if (
    event.type === "connection.lost" ||
    event.type === "connection.restored" ||
    event.type === "seat.reclaim_requested"
  ) {
    return { kind: "noop" as const, state };
  }
  if (state.practice) {
    if (event.type === "connection.grace_expired") {
      return {
        kind: "applied" as const,
        events: [],
        roomDirectives: [{ seatId: event.seatId, type: "seat.release" as const }],
        state,
      };
    }
    return { kind: "noop" as const, state };
  }
  if (event.type !== "connection.grace_expired" && event.type !== "member.left") {
    return { kind: "noop" as const, state };
  }
  const winnerSeatId = otherSeatForSystem(state, event.seatId);
  const reason: BilliardsEndReason = event.type === "member.left" ? "left" : "disconnected";
  const nextState: BilliardsMatchState = {
    ...state,
    activeSeatId: null,
    ballInHandZone: null,
    outcome: { reason, winnerSeatId },
    pendingDecision: null,
    phase: "ended",
  };
  return {
    kind: "applied" as const,
    events: [
      {
        reason,
        type: "billiards.match-ended" as const,
        winnerSeatId,
      } satisfies BilliardsDisplayEvent,
    ],
    outcome: { kind: "completed" as const, publicSummary: outcomeSummary(nextState) },
    state: nextState,
  };
}

function otherSeatForSystem(state: Readonly<BilliardsMatchState>, seatId: SeatId): SeatId {
  const other = state.seatIds.find((candidate) => candidate !== seatId);
  if (!other) throw new GameRuleError("REQUIRES_TWO_PLAYERS");
  return other;
}

export function projectBilliardsView(
  _context: Readonly<ProjectionContextV1>,
  state: Readonly<BilliardsMatchState>,
  viewer: ViewerV1,
): BilliardsView {
  const table = getBilliardsTableSpec(state.settings.mode);
  const viewerSeatId = viewer.kind === "player" ? viewer.seatId : null;
  const viewerIsPlayer = viewer.kind === "player" && state.seatIds.includes(viewer.seatId);
  const viewerIsCurrent = viewer.kind === "player" && viewer.seatId === state.activeSeatId;
  return {
    activeSeatId: state.activeSeatId,
    ballInHandZone: state.ballInHandZone,
    balls: state.balls.map((ball) => ({ ...ball })),
    breakShot: state.breakShot,
    legalActions: {
      canChooseDecidingBlack:
        viewerIsCurrent &&
        state.phase === "decision" &&
        state.pendingDecision?.type === "deciding-black-choice",
      canChooseGroup:
        viewerIsCurrent &&
        state.phase === "decision" &&
        state.pendingDecision?.type === "choose-group",
      canPlaceCue: viewerIsCurrent && state.phase === "ball_in_hand",
      canResign: !state.practice && viewerIsPlayer && state.phase !== "ended",
      canResolveBreak:
        viewerIsCurrent &&
        state.phase === "decision" &&
        state.pendingDecision?.type === "break-choice",
      canShoot: viewerIsCurrent && state.phase === "aiming",
    },
    lastShot: state.lastShot
      ? {
          foulCode: state.lastShot.foulCode,
          points: state.lastShot.points,
          pottedBallIds: [...state.lastShot.pottedBallIds],
          seatId: state.lastShot.seatId,
        }
      : null,
    mode: state.settings.mode,
    outcome: state.outcome,
    pendingDecision: state.pendingDecision
      ? state.pendingDecision.type === "break-choice"
        ? { ...state.pendingDecision, choices: [...state.pendingDecision.choices] }
        : state.pendingDecision.type === "choose-group"
          ? { ...state.pendingDecision, groups: [...state.pendingDecision.groups] }
          : { ...state.pendingDecision, choices: [...state.pendingDecision.choices] }
      : null,
    phase: state.phase,
    players: state.players.map((player) => ({
      active: player.seatId === state.activeSeatId,
      group: player.group,
      score: player.score,
      seatId: player.seatId,
    })),
    practice: state.practice,
    shotNumber: state.shotNumber,
    snookerOn: state.snookerOn,
    table: {
      ballDiameter: table.ballDiameter,
      ballMass: table.ballMass,
      baulkLineX: table.baulkLineX,
      circularCushions: table.circularCushions.map((cushion) => ({ ...cushion })),
      cushionWidth: table.cushionWidth,
      dRadius: table.dRadius,
      height: table.height,
      linearCushions: table.linearCushions.map((cushion) => ({ ...cushion })),
      mode: table.mode,
      outerHeight: table.outerHeight,
      outerWidth: table.outerWidth,
      pockets: table.pockets.map((pocket) => ({ ...pocket })),
      spots: table.spots.map((spot) => ({ ...spot })),
      width: table.width,
    },
    viewerSeatId,
  };
}
