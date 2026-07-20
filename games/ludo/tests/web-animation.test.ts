import { describe, expect, it } from "vitest";

import { ludoAnimationDurationMs, ludoAnimationSegments } from "../web/animation.js";
import { LUDO_BOARD_PRESENTATION, type LudoDisplayStep } from "../shared/index.js";

describe("ludo web movement animation", () => {
  it("keeps authoritative movement endpoints in display-event order", () => {
    const events: LudoDisplayStep[] = [
      {
        type: "move",
        planeId: "red-plane-1",
        fromCellId: "main-0",
        toCellId: "main-1",
        direction: "forward",
      },
      {
        type: "bounce",
        planeId: "red-plane-1",
        atCellId: "main-1",
        reason: "blockade",
      },
      {
        type: "move",
        planeId: "red-plane-1",
        fromCellId: "main-1",
        toCellId: "main-0",
        direction: "backward",
      },
      {
        type: "jump",
        planeId: "red-plane-1",
        fromCellId: "main-1",
        toCellId: "main-5",
      },
      {
        type: "fly",
        planeId: "red-plane-1",
        fromCellId: "main-17",
        toCellId: "home-green-2",
      },
      {
        type: "fly",
        planeId: "red-plane-1",
        fromCellId: "home-green-2",
        toCellId: "main-29",
      },
    ];

    expect(ludoAnimationSegments(events, LUDO_BOARD_PRESENTATION.cells)).toEqual([
      {
        kind: "move",
        planeId: "red-plane-1",
        fromCellId: "main-0",
        toCellId: "main-1",
      },
      {
        kind: "move",
        planeId: "red-plane-1",
        fromCellId: "main-1",
        toCellId: "main-0",
      },
      {
        kind: "jump",
        planeId: "red-plane-1",
        fromCellId: "main-1",
        toCellId: "main-5",
      },
      {
        kind: "fly",
        planeId: "red-plane-1",
        fromCellId: "main-17",
        toCellId: "home-green-2",
      },
      {
        kind: "fly",
        planeId: "red-plane-1",
        fromCellId: "home-green-2",
        toCellId: "main-29",
      },
    ]);
  });

  it("animates launches and ignores endpoints unknown to the projected board", () => {
    const events: LudoDisplayStep[] = [
      {
        type: "launch",
        planeId: "blue-plane-2",
        fromCellId: "base-blue-2",
        toCellId: "apron-blue",
      },
      {
        type: "move",
        planeId: "blue-plane-2",
        fromCellId: "missing-cell",
        toCellId: "main-39",
        direction: "forward",
      },
    ];

    expect(ludoAnimationSegments(events, LUDO_BOARD_PRESENTATION.cells)).toEqual([
      {
        kind: "launch",
        planeId: "blue-plane-2",
        fromCellId: "base-blue-2",
        toCellId: "apron-blue",
      },
    ]);
  });

  it("uses short, positive durations for every confirmed movement kind", () => {
    expect((["launch", "move", "jump", "fly"] as const).map(ludoAnimationDurationMs)).toEqual([
      220, 140, 260, 360,
    ]);
  });
});
