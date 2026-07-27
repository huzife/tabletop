import {
  parseSceneDocument,
  type EllipseElement,
  type ImageElement,
  type PolylineElement,
  type SceneDocument,
} from "@tabletop/scene/schema";

import type { BilliardsMode } from "./settings.js";

export const BILLIARDS_SCENE_ELEMENT_NAMES = {
  boundary: "boundary",
  hole: "hole",
  table: "table",
} as const;

export const CHINESE_EIGHT_BALL_SCENE_DIMENSIONS = {
  outerHeight: 1550,
  outerWidth: 2830,
  playHeight: 1270,
  playWidth: 2540,
} as const;

export interface BilliardsTableScene {
  readonly boundary: PolylineElement;
  readonly document: SceneDocument;
  readonly holes: readonly EllipseElement[];
  readonly mode: BilliardsMode;
  readonly table: ImageElement;
}

export interface BilliardsSceneCalibration {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

/**
 * Validates the billiards-specific contract layered on top of tabletop.scene/v1.
 * Billiards scene coordinates are millimetres with the full outer table as the
 * canvas; the runtime derives physical metres from the boundary calibration.
 */
export function parseBilliardsTableScene(mode: BilliardsMode, input: unknown): BilliardsTableScene {
  const document = parseSceneDocument(input);
  const tableElements = document.elements.filter(
    (element) => element.name === BILLIARDS_SCENE_ELEMENT_NAMES.table,
  );
  const tables = document.elements.filter(
    (element): element is ImageElement =>
      element.type === "image" && element.name === BILLIARDS_SCENE_ELEMENT_NAMES.table,
  );
  const boundaryElements = document.elements.filter(
    (element) => element.name === BILLIARDS_SCENE_ELEMENT_NAMES.boundary,
  );
  const boundaries = document.elements.filter(
    (element): element is PolylineElement =>
      element.type === "polyline" && element.name === BILLIARDS_SCENE_ELEMENT_NAMES.boundary,
  );
  const holeElements = document.elements.filter(
    (element) => element.name === BILLIARDS_SCENE_ELEMENT_NAMES.hole,
  );
  const holes = document.elements.filter(
    (element): element is EllipseElement =>
      element.type === "ellipse" && element.name === BILLIARDS_SCENE_ELEMENT_NAMES.hole,
  );

  if (tableElements.length !== 1 || tables.length !== 1) {
    throw new Error(`${mode} 场景必须且只能包含一个名为 table 的图片元素`);
  }
  if (boundaryElements.length !== 1 || boundaries.length !== 1) {
    throw new Error(`${mode} 场景必须且只能包含一个名为 boundary 的多边形元素`);
  }
  if (holeElements.length !== 6 || holes.length !== 6) {
    throw new Error(`${mode} 场景必须包含六个名为 hole 的椭圆元素`);
  }

  const table = tables[0];
  const boundary = boundaries[0];
  const coordinates = document.canvas.coordinateSystem;
  if (
    coordinates.origin !== "top-left" ||
    coordinates.xAxis !== "right" ||
    coordinates.yAxis !== "down" ||
    coordinates.unit !== "scene-unit" ||
    document.canvas.scaleMode !== "contain"
  ) {
    throw new Error(`${mode} 场景坐标系必须是 top-left / right / down / scene-unit`);
  }
  if (
    table === undefined ||
    table.role === "collision" ||
    !table.visible ||
    table.rotation !== 0 ||
    table.x !== 0 ||
    table.y !== 0 ||
    table.width !== document.canvas.width ||
    table.height !== document.canvas.height ||
    !table.source.startsWith("./")
  ) {
    throw new Error(`${mode} 的 table 必须是覆盖画布、可见、未旋转且使用相对资源地址的视觉图片`);
  }
  if (
    boundary === undefined ||
    boundary.role === "visual" ||
    !boundary.closed ||
    boundary.rotation !== 0
  ) {
    throw new Error(`${mode} 的 boundary 必须是未旋转的闭合碰撞多边形`);
  }
  if (holes.some((hole) => hole.role === "visual" || hole.rotation !== 0)) {
    throw new Error(`${mode} 的 hole 必须是未旋转的碰撞椭圆`);
  }

  const scene = { boundary, document, holes, mode, table };
  const calibration = deriveBilliardsSceneCalibration(scene);
  if (
    mode === "chinese-eight-ball" &&
    (document.canvas.width !== CHINESE_EIGHT_BALL_SCENE_DIMENSIONS.outerWidth ||
      document.canvas.height !== CHINESE_EIGHT_BALL_SCENE_DIMENSIONS.outerHeight ||
      calibration.right - calibration.left !== CHINESE_EIGHT_BALL_SCENE_DIMENSIONS.playWidth ||
      calibration.bottom - calibration.top !== CHINESE_EIGHT_BALL_SCENE_DIMENSIONS.playHeight)
  ) {
    throw new Error(`${mode} 场景必须使用 2830 × 1550 mm 外沿和 2540 × 1270 mm 有效比赛区`);
  }
  return scene;
}

export function deriveBilliardsSceneCalibration(
  scene: Pick<BilliardsTableScene, "boundary" | "document" | "mode">,
): BilliardsSceneCalibration {
  const { boundary, document } = scene;
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
    throw new Error(`${scene.mode} 的 boundary 缺少用于坐标标定的长直边`);
  }
  const calibration = {
    bottom: Math.max(...horizontalLevels),
    left: Math.min(...verticalExtents),
    right: Math.max(...verticalExtents),
    top: Math.min(...horizontalLevels),
  };
  if (calibration.right <= calibration.left || calibration.bottom <= calibration.top) {
    throw new Error(`${scene.mode} 的 boundary 坐标标定范围无效`);
  }
  return calibration;
}
