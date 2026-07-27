import type { SceneCanvas, ScenePoint } from "./schema.js";

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface SceneViewportTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly sceneWidth: number;
  readonly sceneHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

type SceneSize = Pick<SceneCanvas, "height" | "width">;

export function calculateSceneViewport(
  scene: SceneSize,
  viewport: ViewportSize,
): SceneViewportTransform {
  const sceneWidth = positive(scene.width);
  const sceneHeight = positive(scene.height);
  const viewportWidth = positive(viewport.width);
  const viewportHeight = positive(viewport.height);
  const scale = Math.min(viewportWidth / sceneWidth, viewportHeight / sceneHeight);
  const renderedWidth = sceneWidth * scale;
  const renderedHeight = sceneHeight * scale;

  return {
    scale,
    offsetX: (viewportWidth - renderedWidth) / 2,
    offsetY: (viewportHeight - renderedHeight) / 2,
    sceneWidth,
    sceneHeight,
    viewportWidth,
    viewportHeight,
  };
}

export function sceneToViewport(point: ScenePoint, transform: SceneViewportTransform): ScenePoint {
  return {
    x: transform.offsetX + point.x * transform.scale,
    y: transform.offsetY + point.y * transform.scale,
  };
}

export function viewportToScene(point: ScenePoint, transform: SceneViewportTransform): ScenePoint {
  return {
    x: (point.x - transform.offsetX) / transform.scale,
    y: (point.y - transform.offsetY) / transform.scale,
  };
}

export function clientToScene(
  client: ScenePoint,
  bounds: { readonly left: number; readonly top: number } & ViewportSize,
  scene: SceneSize,
): ScenePoint {
  const transform = calculateSceneViewport(scene, bounds);
  return viewportToScene(
    {
      x: client.x - bounds.left,
      y: client.y - bounds.top,
    },
    transform,
  );
}

function positive(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("场景和视口尺寸必须是大于 0 的有限数值");
  }
  return value;
}
