import type { BilliardsBall } from "../../shared/view.js";
import type {
  AdjudicatedBilliardsShot,
  BilliardsMatchState,
  ShotAdjudicationInput,
} from "../state.js";
import { markCueBallInHand } from "./common.js";

function mergePocketedBalls(
  state: Readonly<BilliardsMatchState>,
  simulatedBalls: readonly BilliardsBall[],
  pocketedBallIds: readonly string[],
  cueBallPotted: boolean,
): readonly BilliardsBall[] {
  const initialById = new Map(state.balls.map((ball) => [ball.id, ball]));
  const pocketed = new Set(pocketedBallIds);
  return simulatedBalls.map((ball) => ({
    ...ball,
    pocketed:
      initialById.get(ball.id)?.pocketed === true ||
      ball.pocketed ||
      pocketed.has(ball.id) ||
      (ball.kind === "cue" && cueBallPotted),
  }));
}

/** Apply a physics result without competitive scoring, fouls, turns, or terminal rules. */
export function adjudicatePracticeShot(
  input: Readonly<ShotAdjudicationInput>,
): AdjudicatedBilliardsShot {
  const { actorSeatId, simulation, state } = input;
  if (!state.practice || state.seatIds.length !== 1 || state.seatIds[0] !== actorSeatId) {
    throw new TypeError("Practice adjudication requires the sole practice seat");
  }

  const cueBallPotted =
    simulation.cueBallPotted || simulation.pocketedBallIds.some((id) => id === "cue");
  const mergedBalls = mergePocketedBalls(
    state,
    simulation.balls,
    simulation.pocketedBallIds,
    cueBallPotted,
  );
  const balls = cueBallPotted ? markCueBallInHand(mergedBalls) : mergedBalls;

  return {
    foulCode: null,
    points: 0,
    state: {
      ...state,
      activeSeatId: actorSeatId,
      ballInHandZone: cueBallPotted ? "anywhere" : null,
      balls,
      breakShot: false,
      decidingBlack: false,
      lastShot: {
        foulCode: null,
        points: 0,
        pottedBallIds: [...simulation.pocketedBallIds],
        seatId: actorSeatId,
      },
      outcome: null,
      pendingDecision: null,
      phase: cueBallPotted ? "ball_in_hand" : "aiming",
      shotNumber: state.shotNumber + 1,
      snookerOn: null,
    },
  };
}
