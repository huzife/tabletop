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
  readonly cushionRestitution: number;
  readonly baulkLineX: number | null;
  readonly dRadius: number | null;
  readonly pockets: readonly TablePocketSpec[];
  readonly spots: readonly TableSpotSpec[];
}

function sixPockets(
  width: number,
  height: number,
  cornerCaptureRadius: number,
  sideCaptureRadius: number,
): readonly TablePocketSpec[] {
  return [
    { captureRadius: cornerCaptureRadius, kind: "corner", x: 0, y: 0 },
    { captureRadius: sideCaptureRadius, kind: "side", x: width / 2, y: 0 },
    { captureRadius: cornerCaptureRadius, kind: "corner", x: width, y: 0 },
    { captureRadius: cornerCaptureRadius, kind: "corner", x: 0, y: height },
    { captureRadius: sideCaptureRadius, kind: "side", x: width / 2, y: height },
    { captureRadius: cornerCaptureRadius, kind: "corner", x: width, y: height },
  ];
}

const CHINESE_WIDTH = 2.54;
const CHINESE_HEIGHT = 1.26;
const CHINESE_HEAD_OFFSET = 0.635;
const SNOOKER_WIDTH = 3.569;
const SNOOKER_HEIGHT = 1.778;
const SNOOKER_BAULK_LINE = 0.737;
const SNOOKER_D_RADIUS = 0.292;
const SNOOKER_BLUE_X = SNOOKER_WIDTH / 2;
const SNOOKER_PINK_X = (SNOOKER_BLUE_X + SNOOKER_WIDTH) / 2;

// Pocket capture radii approximate certified table templates; the rulebooks specify
// the playing surfaces and ball sizes but do not publish one universal mouth width.
export const BILLIARDS_TABLE_SPECS: Readonly<Record<BilliardsMode, BilliardsTableSpec>> = {
  "chinese-eight-ball": {
    ballDiameter: 0.05715,
    ballMass: 0.163,
    baulkLineX: CHINESE_HEAD_OFFSET,
    cushionRestitution: 0.82,
    dRadius: null,
    height: CHINESE_HEIGHT,
    mode: "chinese-eight-ball",
    pockets: sixPockets(CHINESE_WIDTH, CHINESE_HEIGHT, 0.068, 0.073),
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
    ballDiameter: 0.0525,
    ballMass: 0.142,
    baulkLineX: SNOOKER_BAULK_LINE,
    cushionRestitution: 0.78,
    dRadius: SNOOKER_D_RADIUS,
    height: SNOOKER_HEIGHT,
    mode: "snooker",
    pockets: sixPockets(SNOOKER_WIDTH, SNOOKER_HEIGHT, 0.066, 0.071),
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
