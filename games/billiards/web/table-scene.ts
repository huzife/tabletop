import type { ImageElement } from "@tabletop/scene";

import { billiardsSceneAsset } from "../physics/scene-assets.js";
import { loadBrowserBilliardsTableScene } from "../physics/scene-browser.js";
import {
  deriveBilliardsSceneCalibration,
  type BilliardsSceneCalibration,
  type BilliardsTableScene,
} from "../shared/scene.js";
import type { BilliardsMode } from "../shared/settings.js";
import type { TableGeometry } from "./canvas.js";

export interface LoadedBilliardsTableScene {
  readonly calibration: BilliardsSceneCalibration;
  readonly image: HTMLImageElement;
  readonly scene: BilliardsTableScene;
}

const scenePromises = new Map<BilliardsMode, Promise<LoadedBilliardsTableScene>>();

export function loadBilliardsTableScene(
  mode: BilliardsMode,
): Promise<LoadedBilliardsTableScene | undefined> {
  const asset = billiardsSceneAsset(mode);
  if (asset === undefined) return Promise.resolve(undefined);

  const cached = scenePromises.get(mode);
  if (cached !== undefined) return cached;

  const pending = loadBrowserBilliardsTableScene(mode)
    .then(async (scene) => {
      if (scene === undefined) {
        throw new Error(`${mode} 缺少已登记的球桌场景`);
      }
      return {
        calibration: deriveBilliardsSceneCalibration(scene),
        image: await loadImage(asset.tableImageUrl, mode),
        scene,
      };
    })
    .catch((error: unknown) => {
      scenePromises.delete(mode);
      throw error;
    });
  scenePromises.set(mode, pending);
  return pending;
}

export function drawBilliardsTableScene(
  context: CanvasRenderingContext2D,
  geometry: TableGeometry,
  loaded: LoadedBilliardsTableScene,
): boolean {
  const { calibration, image, scene } = loaded;
  const imageElement = scene.table;
  const scaleX = geometry.playWidth / (calibration.right - calibration.left);
  const scaleY = geometry.playHeight / (calibration.bottom - calibration.top);

  context.save();
  context.translate(
    geometry.playLeft - calibration.left * scaleX,
    geometry.playTop - calibration.top * scaleY,
  );
  context.scale(scaleX, scaleY);
  context.globalAlpha = imageElement.opacity;
  drawImageElement(context, imageElement, image);
  context.restore();
  return true;
}

function loadImage(source: string | URL, mode: BilliardsMode): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error(`无法加载 ${mode} 球桌图片：${String(source)}`)),
      { once: true },
    );
    image.src = String(source);
  });
}

function drawImageElement(
  context: CanvasRenderingContext2D,
  element: ImageElement,
  image: HTMLImageElement,
): void {
  if (element.fit === "fill") {
    context.drawImage(image, element.x, element.y, element.width, element.height);
    return;
  }
  const naturalWidth = Math.max(1, image.naturalWidth);
  const naturalHeight = Math.max(1, image.naturalHeight);
  const scale =
    element.fit === "cover"
      ? Math.max(element.width / naturalWidth, element.height / naturalHeight)
      : Math.min(element.width / naturalWidth, element.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  const x = element.x + (element.width - width) / 2;
  const y = element.y + (element.height - height) / 2;

  context.save();
  context.beginPath();
  context.rect(element.x, element.y, element.width, element.height);
  context.clip();
  context.drawImage(image, x, y, width, height);
  context.restore();
}
