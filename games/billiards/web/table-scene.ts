import {
  fetchSceneDocument,
  resolveSceneAssetSource,
  type ImageElement,
  type PolylineElement,
  type SceneDocument,
} from "@tabletop/scene";

import type { TableGeometry } from "./canvas.js";

const CHINESE_EIGHT_BALL_SCENE_URL = new URL(
  "./assets/chinese-eight-ball-table.json",
  import.meta.url,
);
const CHINESE_EIGHT_BALL_IMAGE_URL = new URL(
  "./assets/chinese-eight-ball-table-top-view.png",
  import.meta.url,
);
const CHINESE_EIGHT_BALL_IMAGE_SOURCE = "./chinese-eight-ball-table-top-view.png";

export interface TableSceneCalibration {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

export interface LoadedChineseEightBallScene {
  readonly calibration: TableSceneCalibration;
  readonly document: SceneDocument;
  readonly image: HTMLImageElement;
  readonly imageElement: ImageElement;
}

let scenePromise: Promise<LoadedChineseEightBallScene> | undefined;

export function loadChineseEightBallScene(): Promise<LoadedChineseEightBallScene> {
  scenePromise ??= fetchSceneDocument(CHINESE_EIGHT_BALL_SCENE_URL)
    .then(async (document) => {
      const imageElement = document.elements.find(
        (element): element is ImageElement =>
          element.type === "image" && element.visible && element.role !== "collision",
      );
      if (imageElement === undefined) {
        throw new Error("中八场景缺少可见的图片元素");
      }
      if (!imageElement.source.startsWith("./")) {
        throw new Error("中八场景图片必须使用相对于场景描述文件的地址");
      }
      const imageUrl =
        imageElement.source === CHINESE_EIGHT_BALL_IMAGE_SOURCE
          ? CHINESE_EIGHT_BALL_IMAGE_URL
          : resolveSceneAssetSource(imageElement.source, CHINESE_EIGHT_BALL_SCENE_URL);
      return {
        calibration: deriveTableSceneCalibration(document),
        document,
        image: await loadImage(imageUrl),
        imageElement,
      };
    })
    .catch((error: unknown) => {
      scenePromise = undefined;
      throw error;
    });
  return scenePromise;
}

export function deriveTableSceneCalibration(document: SceneDocument): TableSceneCalibration {
  const boundary = document.elements.find(
    (element): element is PolylineElement =>
      element.type === "polyline" &&
      element.name === "boundary" &&
      element.role !== "visual" &&
      element.closed,
  );
  if (boundary === undefined) {
    throw new Error("中八场景缺少闭合的 boundary 碰撞多边形");
  }

  const horizontalLevels: number[] = [];
  const verticalExtents: number[] = [];
  for (const [index, first] of boundary.points.entries()) {
    const second = boundary.points[(index + 1) % boundary.points.length];
    if (second === undefined) continue;
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    if (Math.abs(dy) <= 1e-9 && Math.abs(dx) >= document.canvas.width * 0.25) {
      horizontalLevels.push(first.y);
    }
    if (
      Math.abs(dx) <= document.canvas.width * 0.01 &&
      Math.abs(dy) >= document.canvas.height * 0.25
    ) {
      verticalExtents.push(first.x, second.x);
    }
  }
  if (horizontalLevels.length < 2 || verticalExtents.length < 4) {
    throw new Error("中八 boundary 缺少用于坐标标定的长直边");
  }
  const calibration = {
    bottom: Math.max(...horizontalLevels),
    left: Math.min(...verticalExtents),
    right: Math.max(...verticalExtents),
    top: Math.min(...horizontalLevels),
  };
  if (calibration.right <= calibration.left || calibration.bottom <= calibration.top) {
    throw new Error("中八 boundary 的坐标标定范围无效");
  }
  return calibration;
}

export function drawChineseEightBallScene(
  context: CanvasRenderingContext2D,
  geometry: TableGeometry,
  scene: LoadedChineseEightBallScene,
): boolean {
  const { calibration, image, imageElement } = scene;
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

function loadImage(source: string | URL): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error(`无法加载中八球桌图片：${String(source)}`)),
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
