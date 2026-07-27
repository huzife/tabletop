import { describe, expect, it } from "vitest";

import {
  createElementFromDrag,
  createImageElement,
  createPolylineElement,
  frameFromPoints,
  moveElementWithinCanvas,
  snapPoint,
} from "./editor-model";

describe("editor geometry", () => {
  it("normalizes a drag made in any direction", () => {
    expect(frameFromPoints({ x: 200, y: 160 }, { x: 80, y: 40 })).toEqual({
      x: 80,
      y: 40,
      width: 120,
      height: 120,
    });
    expect(
      createElementFromDrag("rectangle", { x: 200, y: 160 }, { x: 80, y: 40 }, "rectangle"),
    ).toMatchObject({
      id: "rectangle",
      type: "rectangle",
      x: 80,
      y: 40,
      width: 120,
      height: 120,
    });
  });

  it("snaps points only when enabled", () => {
    expect(snapPoint({ x: 27, y: 34 }, 20, true)).toEqual({ x: 20, y: 40 });
    expect(snapPoint({ x: 27, y: 34 }, 20, false)).toEqual({ x: 27, y: 34 });
  });

  it("keeps moved geometry inside the scene canvas", () => {
    const rectangle = createElementFromDrag(
      "rectangle",
      { x: 10, y: 10 },
      { x: 110, y: 60 },
      "rectangle",
    );
    expect(
      moveElementWithinCanvas(rectangle, { x: -80, y: -80 }, { width: 300, height: 200 }),
    ).toMatchObject({
      x: 0,
      y: 0,
    });
  });

  it("scales and centers inserted images without changing aspect ratio", () => {
    expect(
      createImageElement(
        "./assets/board.png",
        "棋盘",
        { width: 1600, height: 800 },
        { width: 1000, height: 600 },
        "image",
      ),
    ).toMatchObject({
      id: "image",
      type: "image",
      width: 520,
      height: 260,
      x: 240,
      y: 170,
      source: "./assets/board.png",
    });
  });

  it("stores every polyline point in scene units", () => {
    const element = createPolylineElement(
      [
        { x: 10, y: 20 },
        { x: 30, y: 40 },
        { x: 80, y: 50 },
      ],
      true,
      "polygon",
    );
    expect(element.points).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
      { x: 80, y: 50 },
    ]);
    expect(element.closed).toBe(true);
  });
});
