import type { BilliardsMode } from "../shared/settings.js";

export interface BilliardsSceneRegistration {
  readonly directory: string;
  readonly mode: BilliardsMode;
  readonly tableImageSource: string;
}

export const CHINESE_EIGHT_BALL_SCENE_REGISTRATION = {
  directory: "chinese-eight-ball",
  mode: "chinese-eight-ball",
  tableImageSource: "./table.png",
} as const satisfies BilliardsSceneRegistration;

export const BILLIARDS_SCENE_REGISTRATIONS: readonly BilliardsSceneRegistration[] = [
  CHINESE_EIGHT_BALL_SCENE_REGISTRATION,
];
