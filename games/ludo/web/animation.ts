import type { BoardCellPresentation, LudoDisplayStep, PlaneId } from "../shared/index.js";

export type LudoAnimationKind = "launch" | "move" | "jump" | "fly";

export interface LudoAnimationSegment {
  readonly kind: LudoAnimationKind;
  readonly planeId: PlaneId;
  readonly fromCellId: string;
  readonly toCellId: string;
}

const DURATION_BY_KIND: Readonly<Record<LudoAnimationKind, number>> = {
  launch: 220,
  move: 140,
  jump: 260,
  fly: 360,
};

export function ludoAnimationDurationMs(kind: LudoAnimationKind): number {
  return DURATION_BY_KIND[kind];
}

export function ludoAnimationSegments(
  events: readonly LudoDisplayStep[],
  cells: readonly BoardCellPresentation[],
): LudoAnimationSegment[] {
  const knownCellIds = new Set(cells.map((cell) => cell.cellId));
  const segments: LudoAnimationSegment[] = [];

  for (const event of events) {
    switch (event.type) {
      case "launch":
      case "move":
      case "jump":
      case "fly":
        if (knownCellIds.has(event.fromCellId) && knownCellIds.has(event.toCellId)) {
          segments.push({
            kind: event.type,
            planeId: event.planeId,
            fromCellId: event.fromCellId,
            toCellId: event.toCellId,
          });
        }
        break;
      case "roll":
      case "bounce":
      case "capture":
      case "jump_cancelled":
      case "finish":
      case "three_sixes":
      case "rank":
      case "turn":
        break;
    }
  }

  return segments;
}
