import { fetchSceneDocument } from "@tabletop/scene";

import { parseBilliardsTableScene, type BilliardsTableScene } from "../shared/scene.js";
import type { BilliardsMode } from "../shared/settings.js";
import { BILLIARDS_SCENE_ASSETS, billiardsSceneAsset } from "./scene-assets.js";

let scenesPromise: Promise<ReadonlyMap<BilliardsMode, BilliardsTableScene>> | undefined;

export function loadBrowserBilliardsTableScenes(): Promise<
  ReadonlyMap<BilliardsMode, BilliardsTableScene>
> {
  scenesPromise ??= Promise.all(
    BILLIARDS_SCENE_ASSETS.map(async (asset) => {
      const document = await fetchSceneDocument(asset.sceneUrl);
      const scene = parseBilliardsTableScene(asset.mode, document);
      if (scene.table.source !== asset.tableImageSource) {
        throw new Error(
          `${asset.mode} 的 table 图片地址必须是 ${asset.tableImageSource}，实际为 ${scene.table.source}`,
        );
      }
      return [asset.mode, scene] as const;
    }),
  )
    .then((entries) => new Map(entries))
    .catch((error: unknown) => {
      scenesPromise = undefined;
      throw error;
    });
  return scenesPromise;
}

export async function loadBrowserBilliardsTableScene(
  mode: BilliardsMode,
): Promise<BilliardsTableScene | undefined> {
  if (billiardsSceneAsset(mode) === undefined) return undefined;
  return (await loadBrowserBilliardsTableScenes()).get(mode);
}
