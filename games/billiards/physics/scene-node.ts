import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseBilliardsTableScene, type BilliardsTableScene } from "../shared/scene.js";
import type { BilliardsMode } from "../shared/settings.js";
import { BILLIARDS_SCENE_REGISTRATIONS } from "./scene-registry.js";

export function loadNodeBilliardsTableScenes(): ReadonlyMap<BilliardsMode, BilliardsTableScene> {
  const scenesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../scenes");
  return new Map(
    BILLIARDS_SCENE_REGISTRATIONS.map((registration) => {
      const scenePath = resolve(scenesRoot, registration.directory, "table.json");
      const input = JSON.parse(readFileSync(scenePath, "utf8")) as unknown;
      const scene = parseBilliardsTableScene(registration.mode, input);
      if (scene.table.source !== registration.tableImageSource) {
        throw new Error(
          `${registration.mode} 的 table 图片地址必须是 ${registration.tableImageSource}，实际为 ${scene.table.source}`,
        );
      }
      const tableImagePath = resolve(
        scenesRoot,
        registration.directory,
        registration.tableImageSource,
      );
      if (!statSync(tableImagePath).isFile()) {
        throw new Error(`${registration.mode} 的 table 图片不是文件`);
      }
      return [registration.mode, scene] as const;
    }),
  );
}
