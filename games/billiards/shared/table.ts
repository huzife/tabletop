import type { BilliardsMode } from "./settings.js";

export interface TablePocketSpec {
  readonly x: number;
  readonly y: number;
  readonly kind: "corner" | "side";
  readonly captureRadius: number;
}

export interface TableSpotSpec {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export interface BilliardsTableSpec {
  readonly mode: BilliardsMode;
  readonly width: number;
  readonly height: number;
  readonly ballDiameter: number;
  readonly ballMass: number;
  readonly baulkLineX: number | null;
  readonly dRadius: number | null;
  readonly pockets: readonly TablePocketSpec[];
  readonly spots: readonly TableSpotSpec[];
}

function pooltoolPockets(
  length: number,
  width: number,
  cornerDepth: number,
  sideDepth: number,
  cornerRadius: number,
  sideRadius: number,
): readonly TablePocketSpec[] {
  const diagonalDepth = cornerDepth / Math.sqrt(2);
  return [
    { captureRadius: cornerRadius, kind: "corner", x: -diagonalDepth, y: -diagonalDepth },
    { captureRadius: sideRadius, kind: "side", x: length / 2, y: -sideDepth },
    {
      captureRadius: cornerRadius,
      kind: "corner",
      x: length + diagonalDepth,
      y: -diagonalDepth,
    },
    {
      captureRadius: cornerRadius,
      kind: "corner",
      x: -diagonalDepth,
      y: width + diagonalDepth,
    },
    { captureRadius: sideRadius, kind: "side", x: length / 2, y: width + sideDepth },
    {
      captureRadius: cornerRadius,
      kind: "corner",
      x: length + diagonalDepth,
      y: width + diagonalDepth,
    },
  ];
}

const CHINESE_WIDTH = 1.9812;
const CHINESE_HEIGHT = 0.9906;
const CHINESE_HEAD_OFFSET = CHINESE_WIDTH / 4;
const SNOOKER_WIDTH = 3.569;
const SNOOKER_HEIGHT = 1.778;
const SNOOKER_BAULK_LINE = 0.737;
const SNOOKER_D_RADIUS = 0.292;
const SNOOKER_BLUE_X = SNOOKER_WIDTH / 2;
const SNOOKER_PINK_X = (SNOOKER_BLUE_X + SNOOKER_WIDTH) / 2;

export const BILLIARDS_TABLE_SPECS: Readonly<Record<BilliardsMode, BilliardsTableSpec>> = {
  "chinese-eight-ball": {
    ballDiameter: 0.05715,
    ballMass: 0.170097,
    baulkLineX: CHINESE_HEAD_OFFSET,
    dRadius: null,
    height: CHINESE_HEIGHT,
    mode: "chinese-eight-ball",
    pockets: pooltoolPockets(CHINESE_WIDTH, CHINESE_HEIGHT, 0.0417, 0.0685, 0.062, 0.0645),
    spots: [
      {
        id: "foot",
        x: CHINESE_WIDTH - CHINESE_HEAD_OFFSET,
        y: CHINESE_HEIGHT / 2,
      },
    ],
    width: CHINESE_WIDTH,
  },
  snooker: {
    ballDiameter: 0.0523875,
    ballMass: 0.14,
    baulkLineX: SNOOKER_BAULK_LINE,
    dRadius: SNOOKER_D_RADIUS,
    height: SNOOKER_HEIGHT,
    mode: "snooker",
    pockets: pooltoolPockets(SNOOKER_WIDTH, SNOOKER_HEIGHT, 0.06735, 0.05159, 0.0889, 0.05319),
    spots: [
      {
        id: "green",
        x: SNOOKER_BAULK_LINE,
        y: SNOOKER_HEIGHT / 2 - SNOOKER_D_RADIUS,
      },
      {
        id: "brown",
        x: SNOOKER_BAULK_LINE,
        y: SNOOKER_HEIGHT / 2,
      },
      {
        id: "yellow",
        x: SNOOKER_BAULK_LINE,
        y: SNOOKER_HEIGHT / 2 + SNOOKER_D_RADIUS,
      },
      { id: "blue", x: SNOOKER_BLUE_X, y: SNOOKER_HEIGHT / 2 },
      { id: "pink", x: SNOOKER_PINK_X, y: SNOOKER_HEIGHT / 2 },
      { id: "black", x: SNOOKER_WIDTH - 0.324, y: SNOOKER_HEIGHT / 2 },
    ],
    width: SNOOKER_WIDTH,
  },
};

export function tableSpecFor(mode: BilliardsMode): BilliardsTableSpec {
  return BILLIARDS_TABLE_SPECS[mode];
}
