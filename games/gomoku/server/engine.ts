import { type SeatId } from "@tabletop/game-sdk";
import {
  GameRuleError,
  type ActionContextV1,
  type CreateMatchContextV1,
  type DeadlineContextV1,
  type GameDeadlineV1,
  type GameOutcomeV1,
  type GameSystemEventV1,
  type GameTransitionV1,
  type ProjectionContextV1,
  type SystemEventContextV1,
  type ViewerV1,
} from "@tabletop/game-sdk/server";

import type { GomokuAction } from "../shared/actions.js";
import type { GomokuSettings } from "../shared/settings.js";
import {
  BOARD_POINT_COUNT,
  type GomokuColor,
  type GomokuCoordinate,
  type GomokuDisplayEvent,
  type GomokuEndReason,
  type GomokuView,
} from "../shared/view.js";
import {
  EMPTY,
  boardIndex,
  createEmptyBoard,
  isInsideBoard,
  oppositeColor,
  withoutStone,
} from "./rules/board.js";
import { evaluatePlacement, getRenjuForbiddenCoordinates } from "./rules/evaluator.js";
import type {
  GomokuClockState,
  GomokuMatchState,
  GomokuMove,
  GomokuPendingOffer,
} from "./state.js";

const OFFER_RESPONSE_MS = 30_000;

type Transition = GameTransitionV1<GomokuMatchState, GomokuDisplayEvent>;

export function createGomokuMatch(
  context: CreateMatchContextV1,
  settings: Readonly<GomokuSettings>,
): GomokuMatchState {
  if (context.seats.length !== 2) {
    throw new GameRuleError("REQUIRES_TWO_PLAYERS");
  }
  const first = context.seats[0];
  const second = context.seats[1];
  if (first === undefined || second === undefined || first.seatId === second.seatId) {
    throw new GameRuleError("REQUIRES_TWO_PLAYERS");
  }
  if (
    settings.rule === "renju" &&
    context.seats.some(({ controller }) => controller.kind === "bot")
  ) {
    throw new GameRuleError("BOTS_NOT_ALLOWED_IN_RENJU");
  }

  const seatIds = [first.seatId, second.seatId] as const;
  const previousSeatByColor = parsePreviousSeatByColor(context.previousSummary?.publicSummary);
  let blackSeat: SeatId;
  if (
    previousSeatByColor !== null &&
    seatIds.includes(previousSeatByColor.black) &&
    seatIds.includes(previousSeatByColor.white) &&
    previousSeatByColor.black !== previousSeatByColor.white
  ) {
    blackSeat = previousSeatByColor.white;
  } else {
    blackSeat = seatIds[context.random.integer(0, 1, "gomoku.first-black-seat")] as SeatId;
  }
  const whiteSeat = seatIds.find((seatId) => seatId !== blackSeat) as SeatId;
  const now = context.clock.monotonicMs();

  return {
    settings: { ...settings },
    phase: "playing",
    board: createEmptyBoard(),
    turn: "black",
    seatByColor: { black: blackSeat, white: whiteSeat },
    botSeatIds: context.seats
      .filter(({ controller }) => controller.kind === "bot")
      .map(({ seatId }) => seatId),
    moves: [],
    clock: createClock(settings, seatIds, now),
    pendingOffer: null,
    undoRequestedAtPositions: [],
    drawOfferHistory: [],
    positionVersion: 0,
    sequence: 0,
    forbiddenMoves: [],
    winningCells: [],
    winnerSeatId: null,
    endReason: null,
  };
}

export function handleGomokuAction(
  context: ActionContextV1,
  state: Readonly<GomokuMatchState>,
  action: GomokuAction,
): Transition {
  const actorSeatId = requirePlayer(state, context.actor.seatId);
  if (state.phase === "ended") {
    throw new GameRuleError("MATCH_ENDED");
  }

  switch (action.type) {
    case "gomoku.place":
      return placeStone(context, state, actorSeatId, action.x, action.y);
    case "gomoku.resign":
      return resign(context, state, actorSeatId);
    case "gomoku.undo.request":
      return requestUndo(context, state, actorSeatId);
    case "gomoku.undo.respond":
      return respondToUndo(context, state, actorSeatId, action.accept);
    case "gomoku.draw.offer":
      return offerDraw(context, state, actorSeatId);
    case "gomoku.draw.respond":
      return respondToDraw(context, state, actorSeatId, action.accept);
  }
}

export function projectGomokuView(
  context: ProjectionContextV1,
  state: Readonly<GomokuMatchState>,
  viewer: ViewerV1,
): GomokuView {
  const now = context.clock.monotonicMs();
  const viewerSeatId = viewer.kind === "spectator" ? null : viewer.seatId;
  const viewerColor = viewerSeatId === null ? null : colorForSeat(state, viewerSeatId);
  const pending = state.pendingOffer;
  const runningClock = projectClock(state, now);
  const lastMove = state.moves.at(-1) ?? null;
  const offerHistoryKey =
    viewerSeatId === null ? null : drawHistoryKey(state.positionVersion, viewerSeatId);

  return {
    boardSize: 15,
    board: [...state.board],
    rule: state.settings.rule,
    phase: state.phase,
    turn: state.phase === "ended" ? null : state.turn,
    revision: context.revision,
    serverNowMonotonicMs: now,
    moveRemainingMs: runningClock.moveRemainingMs,
    players: (["black", "white"] as const).map((color) => ({
      seatId: state.seatByColor[color],
      color,
      totalRemainingMs: runningClock.remainingBySeat[state.seatByColor[color]] ?? null,
    })),
    moves: state.moves.map((move) => ({ ...move })),
    lastMove: lastMove === null ? null : { ...lastMove },
    forbiddenMoves: state.forbiddenMoves.map((point) => ({ ...point })),
    winningCells: state.winningCells.map((point) => ({ ...point })),
    pendingOffer:
      pending === null
        ? null
        : {
            kind: pending.kind,
            requesterSeatId: pending.requesterSeatId,
            responderSeatId: pending.responderSeatId,
            expiresAtMonotonicMs: pending.expiresAtMonotonicMs,
          },
    outcome:
      state.endReason === null
        ? null
        : { winnerSeatId: state.winnerSeatId, reason: state.endReason },
    viewer: { seatId: viewerSeatId, color: viewerColor },
    legalActions: {
      canPlace: viewerColor !== null && state.phase === "playing" && viewerColor === state.turn,
      canResign: viewerColor !== null && state.phase !== "ended",
      canRequestUndo:
        viewerSeatId !== null &&
        state.phase === "playing" &&
        pending === null &&
        lastMove?.seatId === viewerSeatId &&
        !state.undoRequestedAtPositions.includes(state.positionVersion),
      canOfferDraw:
        viewerSeatId !== null &&
        state.phase === "playing" &&
        pending === null &&
        offerHistoryKey !== null &&
        !state.drawOfferHistory.includes(offerHistoryKey),
      canRespondToOffer: viewerSeatId !== null && pending?.responderSeatId === viewerSeatId,
    },
  };
}

export function getGomokuDeadlines(state: Readonly<GomokuMatchState>): readonly GameDeadlineV1[] {
  if (state.phase === "ended") {
    return [];
  }
  const deadlines: GameDeadlineV1[] = [];
  if (state.clock.enabled && state.clock.turnStartedAtMonotonicMs !== null) {
    const turnSeatId = state.seatByColor[state.turn];
    const totalRemaining = getRemainingTotal(state.clock, turnSeatId);
    deadlines.push({
      deadlineId: clockDeadlineId(state),
      dueAtMonotonicMs:
        state.clock.turnStartedAtMonotonicMs +
        Math.min(totalRemaining, state.clock.stepRemainingAtStartMs),
    });
  }
  if (state.pendingOffer !== null) {
    deadlines.push({
      deadlineId: offerDeadlineId(state.pendingOffer),
      dueAtMonotonicMs: state.pendingOffer.expiresAtMonotonicMs,
    });
  }
  return deadlines;
}

export function handleGomokuDeadline(
  context: DeadlineContextV1,
  state: Readonly<GomokuMatchState>,
  deadline: GameDeadlineV1,
): Transition {
  if (state.phase === "ended") {
    return { kind: "noop", state };
  }

  if (deadline.deadlineId === clockDeadlineId(state)) {
    const due = getGomokuDeadlines(state).find(
      ({ deadlineId }) => deadlineId === deadline.deadlineId,
    );
    if (due === undefined || context.firedAtMonotonicMs < due.dueAtMonotonicMs) {
      return { kind: "noop", state };
    }
    const timed = materializeClock(state, context.firedAtMonotonicMs);
    return finishForTimeout(timed.state);
  }

  const pending = state.pendingOffer;
  if (
    pending === null ||
    deadline.deadlineId !== offerDeadlineId(pending) ||
    context.firedAtMonotonicMs < pending.expiresAtMonotonicMs
  ) {
    return { kind: "noop", state };
  }

  if (pending.kind === "undo") {
    const resumed = resumeClock(
      {
        ...state,
        phase: "playing",
        pendingOffer: null,
        sequence: state.sequence + 1,
      },
      pending.expiresAtMonotonicMs,
    );
    const timed = materializeClock(resumed, context.firedAtMonotonicMs);
    if (timed.timedOut) {
      return finishForTimeout(timed.state, [offerResolved("undo", "expired")]);
    }
    return {
      kind: "applied",
      state: timed.state,
      events: [offerResolved("undo", "expired")],
    };
  }

  const timed = materializeClock(state, context.firedAtMonotonicMs);
  if (timed.timedOut) {
    return finishForTimeout(timed.state, [offerResolved("draw", "expired")]);
  }
  return {
    kind: "applied",
    state: {
      ...timed.state,
      pendingOffer: null,
      sequence: state.sequence + 1,
    },
    events: [offerResolved("draw", "expired")],
  };
}

export function handleGomokuSystemEvent(
  context: SystemEventContextV1,
  state: Readonly<GomokuMatchState>,
  event: GameSystemEventV1,
): Transition {
  const color = colorForSeat(state, event.seatId);
  if (color === null) {
    return { kind: "noop", state };
  }
  if (state.phase === "ended") {
    return { kind: "noop", state };
  }

  switch (event.type) {
    case "connection.lost":
      return {
        kind: "applied",
        state,
        events: [],
        roomDirectives: [{ type: "seat.useFallbackController", seatId: event.seatId }],
      };
    case "connection.restored":
      return {
        kind: "applied",
        state,
        events: [],
        roomDirectives: [{ type: "seat.returnHumanControl", seatId: event.seatId }],
      };
    case "connection.grace_expired":
      return finishAfterSystemLoss(context, state, event.seatId, "disconnected");
    case "member.left":
      return finishAfterSystemLoss(context, state, event.seatId, "left");
    case "seat.reclaim_requested":
      return { kind: "noop", state };
  }
}

export function getGomokuActiveSeatIds(state: Readonly<GomokuMatchState>): readonly SeatId[] {
  if (state.phase !== "playing" || state.pendingOffer?.kind === "undo") {
    return [];
  }
  return [state.seatByColor[state.turn]];
}

function placeStone(
  context: ActionContextV1,
  state: Readonly<GomokuMatchState>,
  actorSeatId: SeatId,
  x: number,
  y: number,
): Transition {
  if (state.phase !== "playing") {
    throw new GameRuleError("ACTION_BLOCKED_BY_UNDO");
  }
  if (state.seatByColor[state.turn] !== actorSeatId) {
    throw new GameRuleError("NOT_YOUR_TURN");
  }
  if (!isInsideBoard(x, y)) {
    throw new GameRuleError("OUT_OF_BOUNDS", { x, y });
  }
  if (state.board[boardIndex(x, y)] !== EMPTY) {
    throw new GameRuleError("POSITION_OCCUPIED", { x, y });
  }

  const coordinate = { x, y };
  const evaluation = evaluatePlacement(state.board, state.settings.rule, state.turn, coordinate);
  if (!evaluation.legal) {
    if (evaluation.forbiddenReason !== null) {
      throw new GameRuleError("FORBIDDEN_MOVE", { reason: evaluation.forbiddenReason, x, y });
    }
    throw new GameRuleError("ILLEGAL_MOVE", { x, y });
  }

  const timed = materializeClock(state, context.receivedAtMonotonicMs);
  if (timed.timedOut) {
    return finishForTimeout(timed.state);
  }

  const move: GomokuMove = {
    ...coordinate,
    color: state.turn,
    seatId: actorSeatId,
    moveNumber: state.moves.length + 1,
  };
  const events: GomokuDisplayEvent[] = [
    { type: "gomoku.stonePlaced", ...coordinate, color: state.turn },
  ];
  if (state.pendingOffer?.kind === "draw") {
    events.unshift(offerResolved("draw", "cancelled"));
  }

  const placed: GomokuMatchState = {
    ...timed.state,
    board: evaluation.board,
    moves: [...state.moves, move],
    pendingOffer: null,
    positionVersion: state.positionVersion + 1,
    sequence: state.sequence + 1,
    forbiddenMoves: [],
  };
  if (evaluation.won) {
    return finishMatch(placed, actorSeatId, "five", evaluation.winningCells, events);
  }
  if (placed.moves.length === BOARD_POINT_COUNT) {
    return finishMatch(placed, null, "board_full", [], events);
  }

  const nextTurn = oppositeColor(state.turn);
  const continued: GomokuMatchState = {
    ...placed,
    turn: nextTurn,
    clock: startFreshStep(placed.clock, context.receivedAtMonotonicMs, state.settings),
    forbiddenMoves:
      state.settings.rule === "renju" ? getRenjuForbiddenCoordinates(evaluation.board) : [],
  };
  return { kind: "applied", state: continued, events };
}

function resign(
  context: ActionContextV1,
  state: Readonly<GomokuMatchState>,
  actorSeatId: SeatId,
): Transition {
  const timed = materializeClock(state, context.receivedAtMonotonicMs);
  if (timed.timedOut) {
    return finishForTimeout(timed.state);
  }
  return finishMatch(
    { ...timed.state, sequence: state.sequence + 1 },
    otherSeat(state, actorSeatId),
    "resigned",
  );
}

function requestUndo(
  context: ActionContextV1,
  state: Readonly<GomokuMatchState>,
  actorSeatId: SeatId,
): Transition {
  if (state.phase !== "playing" || state.pendingOffer !== null) {
    throw new GameRuleError("OFFER_ALREADY_PENDING");
  }
  const lastMove = state.moves.at(-1);
  if (
    lastMove === undefined ||
    lastMove.seatId !== actorSeatId ||
    state.undoRequestedAtPositions.includes(state.positionVersion)
  ) {
    throw new GameRuleError("UNDO_NOT_AVAILABLE");
  }

  const timed = materializeClock(state, context.receivedAtMonotonicMs);
  if (timed.timedOut) {
    return finishForTimeout(timed.state);
  }
  const responderSeatId = otherSeat(state, actorSeatId);
  const withHistory: GomokuMatchState = {
    ...timed.state,
    undoRequestedAtPositions: [...state.undoRequestedAtPositions, state.positionVersion],
  };
  if (state.botSeatIds.includes(responderSeatId)) {
    return approveUndo(withHistory, context.receivedAtMonotonicMs, [
      { type: "gomoku.offerCreated", kind: "undo" },
    ]);
  }

  const token = state.sequence + 1;
  return {
    kind: "applied",
    state: {
      ...withHistory,
      phase: "undo_pending",
      clock: pauseClock(withHistory.clock),
      pendingOffer: {
        kind: "undo",
        requesterSeatId: actorSeatId,
        responderSeatId,
        expiresAtMonotonicMs: context.receivedAtMonotonicMs + OFFER_RESPONSE_MS,
        token,
      },
      sequence: token,
    },
    events: [{ type: "gomoku.offerCreated", kind: "undo" }],
  };
}

function respondToUndo(
  context: ActionContextV1,
  state: Readonly<GomokuMatchState>,
  actorSeatId: SeatId,
  accept: boolean,
): Transition {
  const pending = requirePendingOffer(state, "undo", actorSeatId);
  if (context.receivedAtMonotonicMs >= pending.expiresAtMonotonicMs) {
    return expireOfferAtAction(context, state, pending);
  }
  if (accept) {
    return approveUndo(state, context.receivedAtMonotonicMs);
  }
  return {
    kind: "applied",
    state: {
      ...state,
      phase: "playing",
      pendingOffer: null,
      clock: resumeClock(state, context.receivedAtMonotonicMs).clock,
      sequence: state.sequence + 1,
    },
    events: [offerResolved("undo", "rejected")],
  };
}

function approveUndo(
  state: Readonly<GomokuMatchState>,
  now: number,
  prefixEvents: readonly GomokuDisplayEvent[] = [],
): Transition {
  const lastMove = state.moves.at(-1);
  if (lastMove === undefined) {
    throw new GameRuleError("UNDO_NOT_AVAILABLE");
  }
  const board = withoutStone(state.board, lastMove.x, lastMove.y);
  const nextClock = startFreshStep(state.clock, now, state.settings);
  const nextState: GomokuMatchState = {
    ...state,
    phase: "playing",
    board,
    turn: lastMove.color,
    moves: state.moves.slice(0, -1),
    clock: nextClock,
    pendingOffer: null,
    positionVersion: state.positionVersion + 1,
    sequence: state.sequence + 1,
    forbiddenMoves: state.settings.rule === "renju" ? getRenjuForbiddenCoordinates(board) : [],
    winningCells: [],
  };
  return {
    kind: "applied",
    state: nextState,
    events: [
      ...prefixEvents,
      offerResolved("undo", "accepted"),
      { type: "gomoku.stoneRemoved", x: lastMove.x, y: lastMove.y },
    ],
  };
}

function offerDraw(
  context: ActionContextV1,
  state: Readonly<GomokuMatchState>,
  actorSeatId: SeatId,
): Transition {
  if (state.phase !== "playing" || state.pendingOffer !== null) {
    throw new GameRuleError("OFFER_ALREADY_PENDING");
  }
  const historyKey = drawHistoryKey(state.positionVersion, actorSeatId);
  if (state.drawOfferHistory.includes(historyKey)) {
    throw new GameRuleError("DRAW_ALREADY_OFFERED");
  }
  const timed = materializeClock(state, context.receivedAtMonotonicMs);
  if (timed.timedOut) {
    return finishForTimeout(timed.state);
  }

  const responderSeatId = otherSeat(state, actorSeatId);
  const common: GomokuMatchState = {
    ...timed.state,
    drawOfferHistory: [...state.drawOfferHistory, historyKey],
    sequence: state.sequence + 1,
  };
  if (state.botSeatIds.includes(responderSeatId)) {
    return {
      kind: "applied",
      state: common,
      events: [{ type: "gomoku.offerCreated", kind: "draw" }, offerResolved("draw", "rejected")],
    };
  }

  return {
    kind: "applied",
    state: {
      ...common,
      pendingOffer: {
        kind: "draw",
        requesterSeatId: actorSeatId,
        responderSeatId,
        expiresAtMonotonicMs: context.receivedAtMonotonicMs + OFFER_RESPONSE_MS,
        token: state.sequence + 1,
      },
    },
    events: [{ type: "gomoku.offerCreated", kind: "draw" }],
  };
}

function respondToDraw(
  context: ActionContextV1,
  state: Readonly<GomokuMatchState>,
  actorSeatId: SeatId,
  accept: boolean,
): Transition {
  const pending = requirePendingOffer(state, "draw", actorSeatId);
  if (context.receivedAtMonotonicMs >= pending.expiresAtMonotonicMs) {
    return expireOfferAtAction(context, state, pending);
  }
  const timed = materializeClock(state, context.receivedAtMonotonicMs);
  if (timed.timedOut) {
    return finishForTimeout(timed.state, [offerResolved("draw", "cancelled")]);
  }
  if (accept) {
    return finishMatch(
      { ...timed.state, pendingOffer: null, sequence: state.sequence + 1 },
      null,
      "draw_agreed",
      [],
      [offerResolved("draw", "accepted")],
    );
  }
  return {
    kind: "applied",
    state: {
      ...timed.state,
      pendingOffer: null,
      sequence: state.sequence + 1,
    },
    events: [offerResolved("draw", "rejected")],
  };
}

function expireOfferAtAction(
  context: ActionContextV1,
  state: Readonly<GomokuMatchState>,
  pending: GomokuPendingOffer,
): Transition {
  return handleGomokuDeadline(
    {
      matchId: context.matchId,
      revision: context.revision,
      firedAtMonotonicMs: context.receivedAtMonotonicMs,
      clock: context.clock,
      random: context.random,
    },
    state,
    {
      deadlineId: offerDeadlineId(pending),
      dueAtMonotonicMs: pending.expiresAtMonotonicMs,
    },
  );
}

function finishAfterSystemLoss(
  context: SystemEventContextV1,
  state: Readonly<GomokuMatchState>,
  losingSeatId: SeatId,
  reason: "disconnected" | "left",
): Transition {
  const timed = materializeClock(state, context.clock.monotonicMs());
  if (timed.timedOut) {
    return finishForTimeout(timed.state);
  }
  return finishMatch(
    { ...timed.state, sequence: state.sequence + 1 },
    otherSeat(state, losingSeatId),
    reason,
  );
}

function finishForTimeout(
  state: Readonly<GomokuMatchState>,
  prefixEvents: readonly GomokuDisplayEvent[] = [],
): Transition {
  return finishMatch(
    { ...state, pendingOffer: null, sequence: state.sequence + 1 },
    otherSeat(state, state.seatByColor[state.turn]),
    "timeout",
    [],
    prefixEvents,
  );
}

function finishMatch(
  state: Readonly<GomokuMatchState>,
  winnerSeatId: SeatId | null,
  reason: GomokuEndReason,
  winningCells: readonly GomokuCoordinate[] = [],
  prefixEvents: readonly GomokuDisplayEvent[] = [],
): Transition {
  const ended: GomokuMatchState = {
    ...state,
    phase: "ended",
    clock: stopClock(state.clock),
    pendingOffer: null,
    forbiddenMoves: [],
    winningCells: winningCells.map((point) => ({ ...point })),
    winnerSeatId,
    endReason: reason,
  };
  return {
    kind: "applied",
    state: ended,
    events: [...prefixEvents, { type: "gomoku.matchEnded", winnerSeatId, reason }],
    outcome: createOutcome(ended),
  };
}

function createOutcome(state: Readonly<GomokuMatchState>): GameOutcomeV1 {
  return {
    kind: "completed",
    publicSummary: {
      gameId: "gomoku",
      seatByColor: { ...state.seatByColor },
      winnerSeatId: state.winnerSeatId,
      endReason: state.endReason,
    },
  };
}

function createClock(
  settings: Readonly<GomokuSettings>,
  seatIds: readonly SeatId[],
  now: number,
): GomokuClockState {
  if (!settings.timerEnabled) {
    return { enabled: false };
  }
  const totalMs = settings.totalTimeMinutes * 60_000;
  return {
    enabled: true,
    remainingTotalMs: Object.fromEntries(seatIds.map((seatId) => [seatId, totalMs])),
    turnStartedAtMonotonicMs: now,
    stepRemainingAtStartMs: settings.moveTimeSeconds * 1_000,
  };
}

function materializeClock(
  state: Readonly<GomokuMatchState>,
  now: number,
): { readonly state: GomokuMatchState; readonly timedOut: boolean } {
  const clock = state.clock;
  if (!clock.enabled || clock.turnStartedAtMonotonicMs === null || state.phase === "ended") {
    return { state: state as GomokuMatchState, timedOut: false };
  }
  const seatId = state.seatByColor[state.turn];
  const elapsed = Math.max(0, now - clock.turnStartedAtMonotonicMs);
  const totalBefore = getRemainingTotal(clock, seatId);
  const remainingTotal = Math.max(0, totalBefore - elapsed);
  const remainingStep = Math.max(0, clock.stepRemainingAtStartMs - elapsed);
  return {
    state: {
      ...state,
      clock: {
        enabled: true,
        remainingTotalMs: { ...clock.remainingTotalMs, [seatId]: remainingTotal },
        turnStartedAtMonotonicMs: now,
        stepRemainingAtStartMs: remainingStep,
      },
    },
    timedOut: elapsed >= totalBefore || elapsed >= clock.stepRemainingAtStartMs,
  };
}

function startFreshStep(
  clock: GomokuClockState,
  now: number,
  settings: Readonly<GomokuSettings>,
): GomokuClockState {
  return clock.enabled
    ? {
        ...clock,
        turnStartedAtMonotonicMs: now,
        stepRemainingAtStartMs: settings.moveTimeSeconds * 1_000,
      }
    : clock;
}

function pauseClock(clock: GomokuClockState): GomokuClockState {
  return clock.enabled ? { ...clock, turnStartedAtMonotonicMs: null } : clock;
}

function resumeClock(state: Readonly<GomokuMatchState>, now: number): GomokuMatchState {
  return {
    ...state,
    clock: state.clock.enabled ? { ...state.clock, turnStartedAtMonotonicMs: now } : state.clock,
  };
}

function stopClock(clock: GomokuClockState): GomokuClockState {
  return clock.enabled ? { ...clock, turnStartedAtMonotonicMs: null } : clock;
}

function projectClock(
  state: Readonly<GomokuMatchState>,
  now: number,
): {
  readonly remainingBySeat: Readonly<Record<string, number | null>>;
  readonly moveRemainingMs: number | null;
} {
  if (!state.clock.enabled) {
    return { remainingBySeat: {}, moveRemainingMs: null };
  }
  const remaining: Record<string, number | null> = { ...state.clock.remainingTotalMs };
  let moveRemaining = state.clock.stepRemainingAtStartMs;
  if (state.clock.turnStartedAtMonotonicMs !== null && state.phase !== "ended") {
    const elapsed = Math.max(0, now - state.clock.turnStartedAtMonotonicMs);
    const seatId = state.seatByColor[state.turn];
    remaining[seatId] = Math.max(0, getRemainingTotal(state.clock, seatId) - elapsed);
    moveRemaining = Math.max(0, state.clock.stepRemainingAtStartMs - elapsed);
  }
  return { remainingBySeat: remaining, moveRemainingMs: moveRemaining };
}

function getRemainingTotal(
  clock: Extract<GomokuClockState, { enabled: true }>,
  seatId: SeatId,
): number {
  const value = clock.remainingTotalMs[seatId];
  if (value === undefined) {
    throw new RangeError(`clock is missing seat ${seatId}`);
  }
  return value;
}

function parsePreviousSeatByColor(
  summary: unknown,
): { readonly black: SeatId; readonly white: SeatId } | null {
  if (typeof summary !== "object" || summary === null || Array.isArray(summary)) {
    return null;
  }
  const seatByColor = Reflect.get(summary, "seatByColor");
  if (typeof seatByColor !== "object" || seatByColor === null || Array.isArray(seatByColor)) {
    return null;
  }
  const black = Reflect.get(seatByColor, "black");
  const white = Reflect.get(seatByColor, "white");
  return typeof black === "string" && typeof white === "string"
    ? { black: black as SeatId, white: white as SeatId }
    : null;
}

function requirePlayer(state: Readonly<GomokuMatchState>, seatId: SeatId): SeatId {
  if (colorForSeat(state, seatId) === null) {
    throw new GameRuleError("NOT_A_PLAYER");
  }
  return seatId;
}

function colorForSeat(state: Readonly<GomokuMatchState>, seatId: SeatId): GomokuColor | null {
  if (state.seatByColor.black === seatId) {
    return "black";
  }
  if (state.seatByColor.white === seatId) {
    return "white";
  }
  return null;
}

function otherSeat(state: Readonly<GomokuMatchState>, seatId: SeatId): SeatId {
  return state.seatByColor.black === seatId ? state.seatByColor.white : state.seatByColor.black;
}

function requirePendingOffer(
  state: Readonly<GomokuMatchState>,
  kind: "undo" | "draw",
  actorSeatId: SeatId,
): GomokuPendingOffer {
  if (state.pendingOffer?.kind !== kind) {
    throw new GameRuleError("NO_PENDING_OFFER");
  }
  if (state.pendingOffer.responderSeatId !== actorSeatId) {
    throw new GameRuleError("NOT_OFFER_RECIPIENT");
  }
  return state.pendingOffer;
}

function clockDeadlineId(state: Readonly<GomokuMatchState>): string {
  return `gomoku.turn-clock:${state.sequence}:${state.turn}`;
}

function offerDeadlineId(offer: GomokuPendingOffer): string {
  return `gomoku.offer:${offer.token}:${offer.kind}`;
}

function drawHistoryKey(positionVersion: number, seatId: SeatId): string {
  return `${positionVersion}:${seatId}`;
}

function offerResolved(
  kind: "undo" | "draw",
  resolution: "accepted" | "rejected" | "expired" | "cancelled",
): GomokuDisplayEvent {
  return { type: "gomoku.offerResolved", kind, resolution };
}
