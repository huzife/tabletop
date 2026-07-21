import type { SeatId } from "@tabletop/protocol";
import type { GameSystemEventV1 } from "@tabletop/game-sdk/server";
import { GameRuleError } from "@tabletop/game-sdk/server";

import { simulateBilliardsShot } from "../physics/index.js";
import type { BilliardsAction } from "../shared/actions.js";
import { tableSpecFor } from "../shared/table.js";
import type { BilliardsDisplayEvent, BilliardsView } from "../shared/view.js";
import {
  adjudicateChineseEightBallShot,
  resolveEightBallBreakChoice,
  resolveEightBallGroupChoice,
} from "./rules/eight-ball.js";
import { placeCueBall, validateCuePlacement } from "./rules/placement.js";
import { adjudicatePracticeShot } from "./rules/practice.js";
import { adjudicateSnookerShot, resolveSnookerDecidingBlackChoice } from "./rules/snooker.js";
import { createInitialBilliardsState } from "./setup.js";
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
import type { BilliardsSettings } from "../shared/settings.js";

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
  return createInitialBilliardsState(settings, seatIds);
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

  const initialBalls = state.balls.map((ball) => ({ ...ball }));
  const simulation = simulateBilliardsShot({
    balls: initialBalls,
    mode: state.settings.mode,
    shot: action.shot,
  }) as BilliardsSimulationResult;
  const resolution = state.practice
    ? adjudicatePracticeShot({ actorSeatId, shot: action.shot, simulation, state })
    : state.settings.mode === "chinese-eight-ball"
      ? adjudicateChineseEightBallShot({ actorSeatId, shot: action.shot, simulation, state })
      : adjudicateSnookerShot({
          actorSeatId,
          random: context.random,
          shot: action.shot,
          simulation,
          state,
        });
  const nextSeatId = resolution.state.activeSeatId;
  const shotEvent: BilliardsDisplayEvent = {
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
    if (state.practice) throw new GameRuleError("RESIGN_NOT_AVAILABLE_IN_PRACTICE");
    if (context.actor.kind !== "human" || !state.seatIds.includes(context.actor.seatId)) {
      throw new GameRuleError("PLAYER_ONLY");
    }
    const actorSeatId = context.actor.seatId;
    const winnerSeatId = state.seatIds.find((seatId) => seatId !== actorSeatId);
    if (!winnerSeatId) throw new GameRuleError("REQUIRES_TWO_PLAYERS");
    const nextState: BilliardsMatchState = {
      ...state,
      activeSeatId: null,
      ballInHandZone: null,
      outcome: { reason: "resigned", winnerSeatId },
      pendingDecision: null,
      phase: "ended",
    };
    return {
      kind: "applied" as const,
      events: [
        {
          reason: "resigned" as const,
          type: "billiards.match-ended" as const,
          winnerSeatId,
        },
      ],
      outcome: { kind: "completed" as const, publicSummary: outcomeSummary(nextState) },
      state: nextState,
    };
  }
  const actorSeatId = requireCurrentHuman(context, state);
  switch (action.type) {
    case "billiards.place-cue": {
      if (state.phase !== "ball_in_hand" || state.ballInHandZone === null) {
        throw new GameRuleError("CUE_NOT_IN_HAND");
      }
      validateCuePlacement(state, action.x, action.y, state.ballInHandZone);
      return {
        kind: "applied" as const,
        events: [],
        state: {
          ...state,
          ballInHandZone: null,
          balls: placeCueBall(state.balls, action.x, action.y),
          phase: "aiming" as const,
        },
      };
    }
    case "billiards.break-choice":
      return {
        kind: "applied" as const,
        events: [],
        state: resolveEightBallBreakChoice(state, actorSeatId, action.choice),
      };
    case "billiards.choose-group":
      return {
        kind: "applied" as const,
        events: [],
        state: resolveEightBallGroupChoice(state, actorSeatId, action.group),
      };
    case "billiards.deciding-black-choice":
      return {
        kind: "applied" as const,
        events: [],
        state: resolveSnookerDecidingBlackChoice(state, actorSeatId, action.choice),
      };
    case "billiards.shoot":
      return transitionForShot(context, state, actorSeatId, action);
  }
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
  const table = tableSpecFor(state.settings.mode);
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
      baulkLineX: table.baulkLineX,
      dRadius: table.dRadius,
      height: table.height,
      pockets: table.pockets.map((pocket) => ({ ...pocket })),
      spots: table.spots.map((spot) => ({ ...spot })),
      width: table.width,
    },
    viewerSeatId,
  };
}
