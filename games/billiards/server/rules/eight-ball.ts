import { GameRuleError } from "@tabletop/game-sdk/server";
import type { SeatId } from "@tabletop/protocol";

import type { BilliardsBreakChoice, BilliardsSelectableGroup } from "../../shared/actions.js";
import { tableSpecFor } from "../../shared/table.js";
import type { BilliardsBall } from "../../shared/view.js";
import { rerackChineseEightBall } from "../setup.js";
import type {
  AdjudicatedBilliardsShot,
  BilliardsMatchState,
  BilliardsPendingDecision,
  ShotAdjudicationInput,
} from "../state.js";
import {
  ballById,
  endState,
  markCueBallInHand,
  newlyPottedBalls,
  otherSeat,
  updatePlayer,
} from "./common.js";

type ObjectGroup = "solids" | "stripes";
type BreakDecisionReason = Extract<
  BilliardsPendingDecision,
  { readonly type: "break-choice" }
>["reason"];

const BREAK_CHOICES: Readonly<Record<BreakDecisionReason, readonly BilliardsBreakChoice[]>> = {
  "illegal-break": ["accept-table", "rerack-self", "rerack-opponent"],
  "break-foul": ["take-line-in-hand", "rerack-self", "rerack-opponent"],
  "eight-on-break": ["spot-eight", "rerack-self"],
  "eight-on-break-foul": ["spot-eight", "rerack-self", "rerack-opponent"],
};

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

function playerGroup(state: Readonly<BilliardsMatchState>, seatId: SeatId) {
  return state.players.find(({ seatId: id }) => id === seatId)?.group ?? "open";
}

function groupOfBall(ball: Readonly<BilliardsBall>): ObjectGroup | null {
  if (ball.kind === "solid") return "solids";
  if (ball.kind === "stripe") return "stripes";
  return null;
}

function countPottedGroup(balls: readonly BilliardsBall[], group: ObjectGroup): number {
  return balls.filter((ball) => ball.pocketed && groupOfBall(ball) === group).length;
}

function recomputeScores(
  players: readonly BilliardsMatchState["players"][number][],
  balls: readonly BilliardsBall[],
): BilliardsMatchState["players"] {
  return players.map((player) =>
    player.group === "solids" || player.group === "stripes"
      ? { ...player, score: countPottedGroup(balls, player.group) }
      : { ...player, score: 0 },
  ) as unknown as BilliardsMatchState["players"];
}

function assignGroups(
  players: BilliardsMatchState["players"],
  chooserSeatId: SeatId,
  group: ObjectGroup,
): BilliardsMatchState["players"] {
  const opponentGroup = group === "solids" ? "stripes" : "solids";
  const opponentSeatId = players.find(({ seatId }) => seatId !== chooserSeatId)?.seatId;
  if (!opponentSeatId) throw new TypeError("Heyball group assignment requires two players");
  let assigned = updatePlayer(players, chooserSeatId, (player) => ({ ...player, group }));
  assigned = updatePlayer(assigned, opponentSeatId, (player) => ({
    ...player,
    group: opponentGroup,
  }));
  return assigned;
}

function stateAfterShot(
  state: Readonly<BilliardsMatchState>,
  actorSeatId: SeatId,
  balls: readonly BilliardsBall[],
  pottedBallIds: readonly string[],
  foulCode: string | null,
): BilliardsMatchState {
  return {
    ...state,
    balls,
    breakShot: false,
    lastShot: {
      foulCode,
      points: 0,
      pottedBallIds: [...pottedBallIds],
      seatId: actorSeatId,
    },
    outcome: null,
    pendingDecision: null,
    shotNumber: state.shotNumber + 1,
  };
}

function pendingBreakDecision(
  state: Readonly<BilliardsMatchState>,
  actorSeatId: SeatId,
  chooserSeatId: SeatId,
  balls: readonly BilliardsBall[],
  pottedBallIds: readonly string[],
  reason: BreakDecisionReason,
  foulCode: string | null,
): AdjudicatedBilliardsShot {
  const pendingDecision: BilliardsPendingDecision = {
    breakerSeatId: actorSeatId,
    chooserSeatId,
    choices: BREAK_CHOICES[reason],
    reason,
    type: "break-choice",
  };
  return {
    foulCode,
    points: 0,
    state: {
      ...stateAfterShot(state, actorSeatId, balls, pottedBallIds, foulCode),
      activeSeatId: chooserSeatId,
      ballInHandZone: null,
      pendingDecision,
      phase: "decision",
    },
  };
}

function spotEightBall(balls: readonly BilliardsBall[]): readonly BilliardsBall[] {
  const table = tableSpecFor("chinese-eight-ball");
  const spot = table.spots.find(({ id }) => id === "foot");
  const eight = balls.find((ball) => ball.kind === "eight");
  if (!spot || !eight) throw new TypeError("Heyball table is missing the eight or foot spot");
  const radius = table.ballDiameter / 2;
  const withoutEight = balls.map((ball) =>
    ball.kind === "eight" ? { ...ball, pocketed: true } : ball,
  );
  const isFree = (x: number, y: number) =>
    withoutEight.every(
      (ball) => ball.pocketed || Math.hypot(x - ball.x, y - ball.y) >= table.ballDiameter - 1e-9,
    );
  const candidates: { x: number; y: number }[] = [{ x: spot.x, y: spot.y }];
  for (let offset = radius / 2; spot.x + offset <= table.width - radius; offset += radius / 2) {
    candidates.push({ x: spot.x + offset, y: spot.y });
  }
  for (let offset = radius / 2; spot.x - offset >= radius; offset += radius / 2) {
    candidates.push({ x: spot.x - offset, y: spot.y });
  }
  const position = candidates.find(({ x, y }) => isFree(x, y));
  if (!position) throw new GameRuleError("EIGHT_CANNOT_BE_SPOTTED");
  return balls.map((ball) =>
    ball.kind === "eight"
      ? { ...ball, pocketed: false, rotation: 0, x: position.x, y: position.y }
      : ball,
  );
}

/** Apply one authoritative WPA Heyball shot to a match state. */
export function adjudicateChineseEightBallShot(
  input: Readonly<ShotAdjudicationInput>,
): AdjudicatedBilliardsShot {
  const { actorSeatId, shot, simulation, state } = input;
  const opponentSeatId = otherSeat(state, actorSeatId);
  const initialById = new Map(state.balls.map((ball) => [ball.id, ball]));
  const potted = newlyPottedBalls(state, simulation.pocketedBallIds);
  const objectPotted = potted.filter((ball) => ball.kind !== "cue");
  const eightPotted = objectPotted.some((ball) => ball.kind === "eight");
  const cuePotted = simulation.cueBallPotted || potted.some((ball) => ball.kind === "cue");
  const uniqueFirstIds = [...new Set(simulation.firstContactBallIds)];
  const firstBalls = uniqueFirstIds
    .map((id) => ballById(state.balls, id))
    .filter((ball): ball is BilliardsBall => ball !== undefined);
  const jumpedBalls = simulation.jumpedBallIds
    .map((id) => ballById(state.balls, id))
    .filter((ball): ball is BilliardsBall => ball !== undefined);
  const group = playerGroup(state, actorSeatId);
  const ownRemaining =
    group === "solids" || group === "stripes"
      ? state.balls.some((ball) => !ball.pocketed && groupOfBall(ball) === group)
      : false;
  const targetKind = group === "open" || ownRemaining ? group : "eight";
  const legalFirstExists = firstBalls.some((first) => {
    if (state.breakShot) return first.kind !== "cue";
    if (targetKind === "open") return first.kind === "solid" || first.kind === "stripe";
    if (targetKind === "solids") return first.kind === "solid";
    if (targetKind === "stripes") return first.kind === "stripe";
    return first.kind === "eight";
  });
  const noContact = uniqueFirstIds.length === 0;
  const unknownFirstContact = firstBalls.length !== uniqueFirstIds.length;
  const wrongFirst = !noContact && (unknownFirstContact || !legalFirstExists);
  const illegalJump = shot.tip.y < 0 && jumpedBalls.length > 0;

  const distinctObjectRailContacts = new Set(
    simulation.postContactRailBallIds.filter((id) => {
      const ball = initialById.get(id);
      return ball !== undefined && ball.kind !== "cue" && !ball.pocketed;
    }),
  );
  const distinctPostContactRails = new Set(
    simulation.postContactRailBallIds.filter((id) => {
      const ball = initialById.get(id);
      return ball !== undefined && !ball.pocketed;
    }),
  );
  const noRailOrPocket = objectPotted.length === 0 && distinctPostContactRails.size === 0;

  let foulCode: string | null = null;
  if (cuePotted) foulCode = "CUE_BALL_POTTED";
  else if (illegalJump) foulCode = "ILLEGAL_JUMP";
  else if (noContact) foulCode = "NO_OBJECT_CONTACT";
  else if (wrongFirst) foulCode = "WRONG_FIRST_CONTACT";
  else if (!state.breakShot && noRailOrPocket) foulCode = "NO_RAIL_OR_POCKET";

  let balls = withPottedFlags(simulation.balls, simulation.pocketedBallIds, cuePotted);
  if (state.breakShot) {
    const meetsBreakRequirement = objectPotted.length > 0 || distinctObjectRailContacts.size >= 4;
    if (foulCode === null && !meetsBreakRequirement) foulCode = "ILLEGAL_BREAK";
    if (eightPotted) {
      return pendingBreakDecision(
        state,
        actorSeatId,
        foulCode === null ? actorSeatId : opponentSeatId,
        balls,
        simulation.pocketedBallIds,
        foulCode === null ? "eight-on-break" : "eight-on-break-foul",
        foulCode,
      );
    }
    if (foulCode === "ILLEGAL_BREAK") {
      return pendingBreakDecision(
        state,
        actorSeatId,
        opponentSeatId,
        balls,
        simulation.pocketedBallIds,
        "illegal-break",
        foulCode,
      );
    }
    if (foulCode !== null) {
      return pendingBreakDecision(
        state,
        actorSeatId,
        opponentSeatId,
        balls,
        simulation.pocketedBallIds,
        "break-foul",
        foulCode,
      );
    }

    const continueTurn = objectPotted.some((ball) => groupOfBall(ball) !== null);
    return {
      foulCode: null,
      points: 0,
      state: {
        ...stateAfterShot(state, actorSeatId, balls, simulation.pocketedBallIds, null),
        activeSeatId: continueTurn ? actorSeatId : opponentSeatId,
        ballInHandZone: null,
        phase: "aiming",
      },
    };
  }

  const eightIsLegalTarget = targetKind === "eight";
  if (eightPotted) {
    const eightWin = eightIsLegalTarget && foulCode === null;
    const finalFoulCode = eightWin
      ? null
      : eightIsLegalTarget
        ? "EIGHT_BALL_POTTED_ON_FOUL"
        : "EIGHT_BALL_POTTED_EARLY";
    const ended = endState(
      {
        ...stateAfterShot(state, actorSeatId, balls, simulation.pocketedBallIds, finalFoulCode),
        pendingDecision: null,
        phase: "aiming",
        players: recomputeScores(state.players, balls),
      },
      eightWin ? actorSeatId : opponentSeatId,
      "eight-ball",
    );
    return { foulCode: finalFoulCode, points: 0, state: ended };
  }

  let players = state.players;
  const firstGroups = new Set(firstBalls.map(groupOfBall).filter((value) => value !== null));
  const pottedGroups = new Set(objectPotted.map(groupOfBall).filter((value) => value !== null));
  if (foulCode === null && group === "open") {
    let assignedGroup: ObjectGroup | null = null;
    if (firstGroups.size === 1) {
      const onlyFirstGroup = [...firstGroups][0] ?? null;
      if (onlyFirstGroup && pottedGroups.has(onlyFirstGroup)) assignedGroup = onlyFirstGroup;
    } else if (firstGroups.size === 2 && pottedGroups.size === 1) {
      assignedGroup = [...pottedGroups][0] ?? null;
    }
    if (assignedGroup) players = assignGroups(players, actorSeatId, assignedGroup);

    if (firstGroups.size === 2 && pottedGroups.size === 2) {
      const pendingDecision: BilliardsPendingDecision = {
        chooserSeatId: actorSeatId,
        groups: ["solids", "stripes"],
        type: "choose-group",
      };
      return {
        foulCode: null,
        points: 0,
        state: {
          ...stateAfterShot(state, actorSeatId, balls, simulation.pocketedBallIds, null),
          activeSeatId: actorSeatId,
          ballInHandZone: null,
          pendingDecision,
          phase: "decision",
          players: recomputeScores(players, balls),
        },
      };
    }
  }
  players = recomputeScores(players, balls);

  if (foulCode !== null) {
    balls = markCueBallInHand(balls);
    return {
      foulCode,
      points: 0,
      state: {
        ...stateAfterShot(state, actorSeatId, balls, simulation.pocketedBallIds, foulCode),
        activeSeatId: opponentSeatId,
        ballInHandZone: "anywhere",
        phase: "ball_in_hand",
        players,
      },
    };
  }

  const actorGroup = players.find(({ seatId }) => seatId === actorSeatId)?.group ?? "open";
  const scoringPot =
    actorGroup === "open"
      ? pottedGroups.size > 0
      : objectPotted.some((ball) => groupOfBall(ball) === actorGroup);
  return {
    foulCode: null,
    points: 0,
    state: {
      ...stateAfterShot(state, actorSeatId, balls, simulation.pocketedBallIds, null),
      activeSeatId: scoringPot ? actorSeatId : opponentSeatId,
      ballInHandZone: null,
      phase: "aiming",
      players,
    },
  };
}

export function resolveEightBallBreakChoice(
  state: Readonly<BilliardsMatchState>,
  actorSeatId: SeatId,
  choice: BilliardsBreakChoice,
): BilliardsMatchState {
  const pending = state.pendingDecision;
  if (state.phase !== "decision" || pending?.type !== "break-choice") {
    throw new GameRuleError("NO_BREAK_DECISION_PENDING");
  }
  if (pending.chooserSeatId !== actorSeatId) throw new GameRuleError("NOT_YOUR_TURN");
  if (!pending.choices.includes(choice)) throw new GameRuleError("BREAK_CHOICE_NOT_AVAILABLE");

  if (choice === "rerack-self") return rerackChineseEightBall(state, actorSeatId);
  if (choice === "rerack-opponent") {
    return rerackChineseEightBall(state, pending.breakerSeatId);
  }
  if (choice === "accept-table") {
    return {
      ...state,
      activeSeatId: actorSeatId,
      ballInHandZone: null,
      pendingDecision: null,
      phase: "aiming",
    };
  }
  if (choice === "take-line-in-hand") {
    return {
      ...state,
      activeSeatId: actorSeatId,
      ballInHandZone: "behind-line",
      balls: markCueBallInHand(state.balls),
      pendingDecision: null,
      phase: "ball_in_hand",
    };
  }

  const foulEight = pending.reason === "eight-on-break-foul";
  return {
    ...state,
    activeSeatId: actorSeatId,
    ballInHandZone: foulEight ? "behind-line" : null,
    balls: foulEight ? markCueBallInHand(spotEightBall(state.balls)) : spotEightBall(state.balls),
    pendingDecision: null,
    phase: foulEight ? "ball_in_hand" : "aiming",
  };
}

export function resolveEightBallGroupChoice(
  state: Readonly<BilliardsMatchState>,
  actorSeatId: SeatId,
  group: BilliardsSelectableGroup,
): BilliardsMatchState {
  const pending = state.pendingDecision;
  if (state.phase !== "decision" || pending?.type !== "choose-group") {
    throw new GameRuleError("NO_GROUP_DECISION_PENDING");
  }
  if (pending.chooserSeatId !== actorSeatId) throw new GameRuleError("NOT_YOUR_TURN");
  if (!pending.groups.includes(group)) throw new GameRuleError("GROUP_CHOICE_NOT_AVAILABLE");
  const players = recomputeScores(assignGroups(state.players, actorSeatId, group), state.balls);
  return {
    ...state,
    activeSeatId: actorSeatId,
    ballInHandZone: null,
    pendingDecision: null,
    phase: "aiming",
    players,
  };
}
