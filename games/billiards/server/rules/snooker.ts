import type { GameRandomV1 } from "@tabletop/game-sdk/server";
import type { SeatId } from "@tabletop/protocol";

import { GameRuleError } from "@tabletop/game-sdk/server";

import { tableSpecFor } from "../../shared/table.js";
import type { BilliardsDecidingBlackChoice } from "../../shared/actions.js";
import type { BilliardsBall, SnookerOn } from "../../shared/view.js";
import {
  addScore,
  ballById,
  endState,
  isSnookerColor,
  markCueBallInHand,
  newlyPottedBalls,
  otherSeat,
  requireCompetitivePlayers,
  SNOOKER_COLOR_VALUES,
  SNOOKER_COLORS_ASCENDING,
} from "./common.js";
import type {
  AdjudicatedBilliardsShot,
  BilliardsMatchState,
  BilliardsSimulationResult,
  ShotAdjudicationInput,
} from "../state.js";

function withPottedFlags(
  balls: readonly BilliardsBall[],
  pocketedIds: readonly string[],
  cuePotted: boolean,
): readonly BilliardsBall[] {
  const pocketed = new Set(pocketedIds);
  return balls.map((ball) =>
    ball.kind === "cue"
      ? { ...ball, pocketed: ball.pocketed || cuePotted || pocketed.has(ball.id) }
      : { ...ball, pocketed: ball.pocketed || pocketed.has(ball.id) },
  );
}

function colorSpotPosition(
  kind: string,
  balls: readonly BilliardsBall[],
  ignoredBallId: string,
): { x: number; y: number } | null {
  const table = tableSpecFor("snooker");
  const own = table.spots.find((spot) => spot.id === kind);
  if (!own) return null;
  const radius = table.ballDiameter / 2;
  const occupied = (x: number, y: number) =>
    balls.some(
      (ball) =>
        ball.id !== ignoredBallId &&
        !ball.pocketed &&
        Math.hypot(x - ball.x, y - ball.y) < table.ballDiameter - 1e-9,
    );
  if (!occupied(own.x, own.y)) return own;

  // If a color's own spot is occupied, the rules use the highest-value free
  // spot. The final fallback searches along the table's longitudinal centre
  // line, which is the prescribed direction when all spots are occupied.
  const byValue = [...SNOOKER_COLORS_ASCENDING].reverse();
  for (const candidate of byValue) {
    const spot = table.spots.find(({ id }) => id === candidate);
    if (spot && !occupied(spot.x, spot.y)) return spot;
  }
  for (let step = 1; step < 500; step += 1) {
    const x = Math.min(table.width - radius, own.x + (step * radius) / 2);
    if (!occupied(x, own.y)) return { x, y: own.y };
    if (x >= table.width - radius) break;
  }
  for (let step = 1; step < 500; step += 1) {
    const x = Math.max(radius, own.x - (step * radius) / 2);
    if (!occupied(x, own.y)) return { x, y: own.y };
    if (x <= radius) break;
  }
  return null;
}

function respotColors(
  balls: readonly BilliardsBall[],
  ids: readonly string[],
): readonly BilliardsBall[] {
  const colorIds = [...new Set(ids)].filter((id) => {
    const ball = balls.find(({ id: candidate }) => candidate === id);
    return ball !== undefined && isSnookerColor(ball.kind);
  });
  // Higher value colors are placed first if one shot somehow pots several.
  colorIds.sort((a, b) => {
    const first = balls.find(({ id }) => id === a)?.value ?? 0;
    const second = balls.find(({ id }) => id === b)?.value ?? 0;
    return second - first;
  });
  let next = balls;
  for (const id of colorIds) {
    const ball = next.find(({ id: candidate }) => candidate === id);
    if (!ball || !isSnookerColor(ball.kind)) continue;
    const position = colorSpotPosition(ball.kind, next, ball.id);
    if (!position) continue;
    next = next.map((candidate) =>
      candidate.id === id
        ? { ...candidate, pocketed: false, x: position.x, y: position.y }
        : candidate,
    );
  }
  return next;
}

function redsRemaining(balls: readonly BilliardsBall[]): number {
  return balls.filter((ball) => ball.kind === "red" && !ball.pocketed).length;
}

function colorsRemaining(balls: readonly BilliardsBall[]): number {
  return balls.filter((ball) => isSnookerColor(ball.kind) && !ball.pocketed).length;
}

function nextColorAfter(color: SnookerOn): SnookerOn | null {
  const index = SNOOKER_COLORS_ASCENDING.findIndex((candidate) => candidate === color);
  if (index < 0) return null;
  return SNOOKER_COLORS_ASCENDING[index + 1] ?? null;
}

function requireNomination(
  state: Readonly<BilliardsMatchState>,
  nominatedColor: string | null,
): void {
  if (state.snookerOn === "color" && nominatedColor === null) {
    throw new GameRuleError("COLOR_NOMINATION_REQUIRED");
  }
}

function finalBlackResolution(
  state: Readonly<BilliardsMatchState>,
  balls: readonly BilliardsBall[],
  players: BilliardsMatchState["players"],
  actorSeatId: SeatId,
  simulation: Readonly<BilliardsSimulationResult>,
  foulCode: string | null,
  points: number,
  random: GameRandomV1,
): AdjudicatedBilliardsShot {
  const [firstPlayer, secondPlayer] = requireCompetitivePlayers(players);
  const tie = firstPlayer.score === secondPlayer.score;
  const base: BilliardsMatchState = {
    ...state,
    balls,
    breakShot: false,
    lastShot: {
      foulCode,
      points,
      pottedBallIds: [...simulation.pocketedBallIds],
      seatId: actorSeatId,
    },
    players,
    shotNumber: state.shotNumber + 1,
  };
  if (tie) {
    const blackId = balls.find((ball) => ball.kind === "black")?.id;
    const withCue = markCueBallInHand(balls);
    const respotted = blackId ? respotColors(withCue, [blackId]) : withCue;
    const chooserSeatId = random.pick(
      state.seatIds,
      `billiards.snooker.deciding-black.${state.shotNumber + 1}.chooser`,
    );
    return {
      foulCode,
      points,
      state: {
        ...base,
        activeSeatId: chooserSeatId,
        ballInHandZone: null,
        balls: respotted,
        decidingBlack: true,
        outcome: null,
        pendingDecision: {
          chooserSeatId,
          choices: ["play-self", "defer"],
          type: "deciding-black-choice",
        },
        phase: "decision",
        snookerOn: "black",
      },
    };
  }
  const winnerSeatId =
    firstPlayer.score > secondPlayer.score ? firstPlayer.seatId : secondPlayer.seatId;
  const ended = endState(
    { ...base, decidingBlack: false, phase: "aiming", snookerOn: "black" },
    winnerSeatId,
    "final-black",
  );
  return { foulCode, points, state: ended };
}

/** Apply one authoritative snooker shot, including scoring and respotting. */
export function adjudicateSnookerShot(
  input: Readonly<ShotAdjudicationInput> & { readonly random: GameRandomV1 },
): AdjudicatedBilliardsShot {
  const { actorSeatId, simulation, state, shot } = input;
  requireNomination(state, shot.nominatedColor);
  const opponentSeatId = otherSeat(state, actorSeatId);
  const potted = newlyPottedBalls(state, simulation.pocketedBallIds);
  const objectPotted = potted.filter((ball) => ball.kind !== "cue");
  const cuePotted = simulation.cueBallPotted || potted.some((ball) => ball.kind === "cue");
  const firstBalls = simulation.firstContactBallIds
    .map((id) => ballById(state.balls, id))
    .filter((ball): ball is BilliardsBall => ball !== undefined);
  const jumpedBalls = simulation.jumpedBallIds
    .map((id) => ballById(state.balls, id))
    .filter((ball): ball is BilliardsBall => ball !== undefined);
  const on = state.snookerOn ?? "red";
  const targetKind = on === "red" ? "red" : on === "color" ? shot.nominatedColor : on;
  if (targetKind === null) throw new GameRuleError("COLOR_NOMINATION_REQUIRED");
  const targetValue = targetKind === "red" ? 1 : SNOOKER_COLOR_VALUES[targetKind];
  const wrongFirst = firstBalls.length === 0 || firstBalls.some((ball) => ball.kind !== targetKind);
  const wrongPotted = objectPotted.some((ball) => ball.kind !== targetKind);
  const noContact = simulation.firstContactBallIds.length === 0;

  let foulCode: string | null = null;
  if (noContact) foulCode = "NO_BALL_CONTACT";
  else if (wrongFirst) foulCode = "WRONG_FIRST_CONTACT";
  else if (wrongPotted) foulCode = "WRONG_BALL_POTTED";
  if (cuePotted) foulCode = "CUE_BALL_POTTED";
  if (simulation.jumpedBallIds.length > 0) foulCode = "JUMP_SHOT";

  let balls = withPottedFlags(simulation.balls, simulation.pocketedBallIds, cuePotted);
  const redsAfter = redsRemaining(balls);
  const pottedRedCount = objectPotted.filter((ball) => ball.kind === "red").length;
  const targetPotted = objectPotted.some((ball) => ball.kind === targetKind);
  const points =
    foulCode === null
      ? on === "red"
        ? pottedRedCount
        : targetPotted
          ? targetValue
          : 0
      : Math.max(
          4,
          targetValue,
          ...firstBalls.map((ball) => ball.value),
          ...jumpedBalls.map((ball) => ball.value),
          ...objectPotted.map((ball) => ball.value),
        );

  // Colors are always returned to their spots while reds remain on the table;
  // during the clearance phase only the target color stays down on a legal pot.
  const respotIds =
    redsAfter > 0 || on === "red" || on === "color"
      ? objectPotted.filter((ball) => isSnookerColor(ball.kind)).map((ball) => ball.id)
      : foulCode !== null
        ? objectPotted.filter((ball) => isSnookerColor(ball.kind)).map((ball) => ball.id)
        : objectPotted
            .filter((ball) => isSnookerColor(ball.kind) && ball.kind !== targetKind)
            .map((ball) => ball.id);
  if (respotIds.length > 0) balls = respotColors(balls, respotIds);

  let players = state.players;
  if (foulCode === null) {
    players = addScore(players, actorSeatId, points);
  } else {
    players = addScore(players, opponentSeatId, points);
  }
  players = players as BilliardsMatchState["players"];

  const finalBlack = on === "black" && redsAfter === 0 && colorsRemaining(balls) <= 1;
  if (finalBlack && (foulCode !== null || targetPotted)) {
    return finalBlackResolution(
      state,
      balls,
      players,
      actorSeatId,
      simulation,
      foulCode,
      points,
      input.random,
    );
  }

  let nextOn: SnookerOn;
  let continueTurn = false;
  if (foulCode !== null) {
    if (on === "red") nextOn = redsAfter > 0 ? "red" : "color";
    else if (on === "color") nextOn = redsAfter > 0 ? "red" : "yellow";
    else nextOn = on;
  } else if (on === "red") {
    if (pottedRedCount > 0) {
      nextOn = "color";
      continueTurn = true;
    } else {
      nextOn = redsAfter > 0 ? "red" : "color";
    }
  } else if (on === "color") {
    nextOn = redsAfter > 0 ? "red" : "yellow";
    continueTurn = targetPotted;
  } else {
    nextOn = targetPotted ? (nextColorAfter(on) ?? "black") : on;
    continueTurn = targetPotted;
  }

  const ballInHand = cuePotted;
  const nextSeatId = continueTurn && foulCode === null ? actorSeatId : opponentSeatId;
  const nextBalls = ballInHand ? markCueBallInHand(balls) : balls;
  return {
    foulCode,
    points,
    state: {
      ...state,
      activeSeatId: nextSeatId,
      ballInHandZone: ballInHand ? "d" : null,
      balls: nextBalls,
      breakShot: false,
      lastShot: {
        foulCode,
        points,
        pottedBallIds: [...simulation.pocketedBallIds],
        seatId: actorSeatId,
      },
      outcome: null,
      phase: ballInHand ? "ball_in_hand" : "aiming",
      players,
      shotNumber: state.shotNumber + 1,
      snookerOn: nextOn,
    },
  };
}

export function resolveSnookerDecidingBlackChoice(
  state: Readonly<BilliardsMatchState>,
  actorSeatId: SeatId,
  choice: BilliardsDecidingBlackChoice,
): BilliardsMatchState {
  const pending = state.pendingDecision;
  if (
    state.settings.mode !== "snooker" ||
    !state.decidingBlack ||
    state.phase !== "decision" ||
    pending?.type !== "deciding-black-choice"
  ) {
    throw new GameRuleError("NO_DECIDING_BLACK_DECISION_PENDING");
  }
  if (pending.chooserSeatId !== actorSeatId) throw new GameRuleError("NOT_YOUR_TURN");
  if (!pending.choices.includes(choice)) {
    throw new GameRuleError("DECIDING_BLACK_CHOICE_NOT_AVAILABLE");
  }
  return {
    ...state,
    activeSeatId: choice === "play-self" ? actorSeatId : otherSeat(state, actorSeatId),
    ballInHandZone: "d",
    pendingDecision: null,
    phase: "ball_in_hand",
  };
}
