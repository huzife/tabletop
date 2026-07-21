import type { SeatId } from "@tabletop/protocol";

import type { BilliardsMode, BilliardsSettings } from "../shared/settings.js";
import { tableSpecFor } from "../shared/table.js";
import type { BilliardsBall, BilliardsBallKind } from "../shared/view.js";
import type { BilliardsMatchState, BilliardsPlayerState } from "./state.js";

const SQRT_THREE_OVER_TWO = Math.sqrt(3) / 2;
const SNOOKER_PINK_RED_GAP = 0.0005;

function numberedBall(number: number, x: number, y: number): BilliardsBall {
  const kind: BilliardsBallKind = number === 8 ? "eight" : number < 8 ? "solid" : "stripe";
  return {
    id: String(number),
    kind,
    number,
    pocketed: false,
    rotation: 0,
    value: number === 8 ? 8 : 1,
    x,
    y,
  };
}

function snookerBall(
  id: string,
  kind: BilliardsBallKind,
  value: number,
  x: number,
  y: number,
): BilliardsBall {
  return { id, kind, number: null, pocketed: false, rotation: 0, value, x, y };
}

export function createChineseEightBallRack(): readonly BilliardsBall[] {
  const table = tableSpecFor("chinese-eight-ball");
  const foot = table.spots.find(({ id }) => id === "foot");
  if (!foot) throw new TypeError("Chinese eight-ball table is missing its foot spot");

  // Fixed legal rack: the eight is central, and the two rear corners are
  // opposite groups. A fixed order keeps server replays deterministic.
  const rows: readonly (readonly number[])[] = [
    [1],
    [9, 2],
    [3, 8, 10],
    [11, 4, 12, 5],
    [6, 13, 7, 14, 15],
  ];
  const balls: BilliardsBall[] = [
    {
      id: "cue",
      kind: "cue",
      number: null,
      pocketed: false,
      rotation: 0,
      value: 0,
      x: table.baulkLineX ?? table.width / 4,
      y: table.height / 2,
    },
  ];

  rows.forEach((row, rowIndex) => {
    const x = foot.x + rowIndex * table.ballDiameter * SQRT_THREE_OVER_TWO;
    row.forEach((number, index) => {
      const y = foot.y + (index - (row.length - 1) / 2) * table.ballDiameter;
      balls.push(numberedBall(number, x, y));
    });
  });
  return balls;
}

export function createSnookerRack(): readonly BilliardsBall[] {
  const table = tableSpecFor("snooker");
  const spots = new Map(table.spots.map((spot) => [spot.id, spot]));
  const brown = spots.get("brown");
  const pink = spots.get("pink");
  if (!brown || !pink || table.dRadius === null) {
    throw new TypeError("Snooker table is missing required spots or D dimensions");
  }

  const balls: BilliardsBall[] = [
    snookerBall("cue", "cue", 0, brown.x - table.dRadius / 2, brown.y),
  ];
  const colorValues = {
    yellow: 2,
    green: 3,
    brown: 4,
    blue: 5,
    pink: 6,
    black: 7,
  } as const;
  for (const [kind, value] of Object.entries(colorValues)) {
    const spot = spots.get(kind);
    if (!spot) throw new TypeError(`Snooker table is missing the ${kind} spot`);
    balls.push(snookerBall(kind, kind as BilliardsBallKind, value, spot.x, spot.y));
  }

  // The apex red sits as close as practical to the pink without touching it.
  let redNumber = 1;
  for (let row = 0; row < 5; row += 1) {
    const x =
      pink.x +
      table.ballDiameter +
      SNOOKER_PINK_RED_GAP +
      row * table.ballDiameter * SQRT_THREE_OVER_TWO;
    for (let index = 0; index <= row; index += 1) {
      const y = pink.y + (index - row / 2) * table.ballDiameter;
      balls.push(snookerBall(`red-${redNumber}`, "red", 1, x, y));
      redNumber += 1;
    }
  }
  return balls;
}

export function createInitialBalls(mode: BilliardsMode): readonly BilliardsBall[] {
  return mode === "chinese-eight-ball" ? createChineseEightBallRack() : createSnookerRack();
}

export function createInitialBilliardsState(
  settings: Readonly<BilliardsSettings>,
  seatIds: readonly SeatId[],
): BilliardsMatchState {
  const firstSeatId = seatIds[0];
  if (!firstSeatId || seatIds.length > 2 || new Set(seatIds).size !== seatIds.length) {
    throw new TypeError("Billiards requires one or two distinct seats");
  }
  const practice = seatIds.length === 1;
  const initialGroup = !practice && settings.mode === "chinese-eight-ball" ? "open" : null;
  const players: readonly BilliardsPlayerState[] = seatIds.map((seatId) => ({
    group: initialGroup,
    score: 0,
    seatId,
  }));
  const balls = createInitialBalls(settings.mode).map((ball) =>
    ball.kind === "cue" ? { ...ball, pocketed: true } : ball,
  );
  return {
    activeSeatId: firstSeatId,
    ballInHandZone: settings.mode === "chinese-eight-ball" ? "behind-line" : "d",
    balls,
    breakShot: true,
    decidingBlack: false,
    lastShot: null,
    outcome: null,
    pendingDecision: null,
    phase: "ball_in_hand",
    players,
    practice,
    seatIds,
    settings,
    shotNumber: 0,
    snookerOn: !practice && settings.mode === "snooker" ? "red" : null,
  };
}

export function rerackChineseEightBall(
  state: Readonly<BilliardsMatchState>,
  breakerSeatId: SeatId,
): BilliardsMatchState {
  if (
    state.practice ||
    state.settings.mode !== "chinese-eight-ball" ||
    !state.seatIds.includes(breakerSeatId)
  ) {
    throw new TypeError("Cannot rerack a non-Heyball match or assign an unknown breaker");
  }
  return {
    ...state,
    activeSeatId: breakerSeatId,
    ballInHandZone: "behind-line",
    balls: createChineseEightBallRack().map((ball) =>
      ball.kind === "cue" ? { ...ball, pocketed: true } : ball,
    ),
    breakShot: true,
    decidingBlack: false,
    outcome: null,
    pendingDecision: null,
    phase: "ball_in_hand",
    players: state.seatIds.map((seatId) => ({
      group: "open" as const,
      score: 0,
      seatId,
    })),
    snookerOn: null,
  };
}
