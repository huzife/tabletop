import type { BilliardsMode } from "../shared/settings.js";
import {
  CHINESE_EIGHT_BALL_SCENE_REGISTRATION,
  type BilliardsSceneRegistration,
} from "./scene-registry.js";

export interface BilliardsSceneAssetDefinition extends BilliardsSceneRegistration {
  readonly sceneUrl: URL;
  readonly tableImageUrl: URL;
}

const CHINESE_EIGHT_BALL_SCENE: BilliardsSceneAssetDefinition = {
  ...CHINESE_EIGHT_BALL_SCENE_REGISTRATION,
  sceneUrl: new URL("../scenes/chinese-eight-ball/table.json", import.meta.url),
  tableImageUrl: new URL("../scenes/chinese-eight-ball/table.png", import.meta.url),
};

export const BILLIARDS_SCENE_ASSETS: readonly BilliardsSceneAssetDefinition[] = [
  CHINESE_EIGHT_BALL_SCENE,
];

export function billiardsSceneAsset(
  mode: BilliardsMode,
): BilliardsSceneAssetDefinition | undefined {
  return BILLIARDS_SCENE_ASSETS.find((asset) => asset.mode === mode);
}
