import type { CueTip } from "../shared/actions.js";

export const CUE_TIP_LIMIT = 0.95;

export interface RectLike {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export function constrainCueTip(x: number, y: number): CueTip {
  const safeX = Number.isFinite(x) ? x : 0;
  const safeY = Number.isFinite(y) ? y : 0;
  const length = Math.hypot(safeX, safeY);
  if (length <= CUE_TIP_LIMIT) return { x: safeX, y: safeY };
  if (length === 0) return { x: 0, y: 0 };
  const scale = CUE_TIP_LIMIT / length;
  return { x: safeX * scale, y: safeY * scale };
}

export function cueTipFromPointer(clientX: number, clientY: number, bounds: RectLike): CueTip {
  if (bounds.width <= 0 || bounds.height <= 0) return { x: 0, y: 0 };
  const radius = Math.min(bounds.width, bounds.height) / 2;
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  return constrainCueTip((clientX - centerX) / radius, (centerY - clientY) / radius);
}

export function nudgeCueTip(tip: CueTip, key: string, step = 0.08): CueTip {
  switch (key) {
    case "ArrowLeft":
      return constrainCueTip(tip.x - step, tip.y);
    case "ArrowRight":
      return constrainCueTip(tip.x + step, tip.y);
    case "ArrowUp":
      return constrainCueTip(tip.x, tip.y + step);
    case "ArrowDown":
      return constrainCueTip(tip.x, tip.y - step);
    case "Home":
      return { x: 0, y: 0 };
    default:
      return tip;
  }
}

export function describeCueTip(tip: CueTip): string {
  const horizontal = tip.x < -0.12 ? "左塞" : tip.x > 0.12 ? "右塞" : "中线";
  const vertical = tip.y > 0.12 ? "高杆" : tip.y < -0.12 ? "低杆" : "中心";
  return `${horizontal}，${vertical}`;
}

export function normalizeDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}
