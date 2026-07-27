import { describe, expect, it } from "vitest";

import {
  calculateSceneViewport,
  clientToScene,
  hitTestScene,
  parseSceneDocument,
  parseSceneJson,
  pointInSceneElement,
  resolveSceneAssetSource,
  sampleSmoothPoints,
  sceneToViewport,
  serializeSceneDocument,
  viewportToScene,
  type FreehandElement,
  type RectangleElement,
  type SceneDocument,
} from "./index.js";

const rectangle: RectangleElement = {
  id: "wall",
  name: "边界",
  type: "rectangle",
  role: "collision",
  visible: true,
  locked: false,
  opacity: 1,
  rotation: 0,
  x: 100,
  y: 80,
  width: 200,
  height: 60,
  cornerRadius: 8,
  style: {
    fill: "#ef4444",
    fillOpacity: 0.15,
    stroke: "#dc2626",
    strokeOpacity: 1,
    strokeWidth: 2,
    dash: [8, 5],
    lineCap: "round",
    lineJoin: "round",
  },
  metadata: {
    label: "不可通行",
    notes: "游戏规则使用的边界",
    tags: ["wall"],
  },
};

const document: SceneDocument = {
  format: "tabletop.scene",
  formatVersion: 1,
  name: "测试场景",
  canvas: {
    width: 1000,
    height: 500,
    background: "#ffffff",
    gridSize: 20,
    coordinateSystem: {
      origin: "top-left",
      xAxis: "right",
      yAxis: "down",
      unit: "scene-unit",
    },
    scaleMode: "contain",
  },
  elements: [rectangle],
};

describe("scene document", () => {
  it("validates and round-trips the versioned format", () => {
    const serialized = serializeSceneDocument(document);
    expect(parseSceneJson(serialized)).toEqual(document);
    expect(serialized.endsWith("\n")).toBe(true);
  });

  it("rejects duplicate element ids", () => {
    expect(() =>
      parseSceneDocument({
        ...document,
        elements: [rectangle, { ...rectangle }],
      }),
    ).toThrow(/重复/);
  });
});

describe("coordinate contract", () => {
  it("uses the same contain transform in both directions", () => {
    const transform = calculateSceneViewport(document.canvas, {
      width: 800,
      height: 800,
    });
    expect(transform).toMatchObject({
      scale: 0.8,
      offsetX: 0,
      offsetY: 200,
    });

    const viewportPoint = sceneToViewport({ x: 250, y: 125 }, transform);
    expect(viewportPoint).toEqual({ x: 200, y: 300 });
    expect(viewportToScene(viewportPoint, transform)).toEqual({ x: 250, y: 125 });
  });

  it("maps a browser client point into scene units", () => {
    expect(
      clientToScene(
        { x: 310, y: 360 },
        { left: 110, top: 60, width: 800, height: 800 },
        document.canvas,
      ),
    ).toEqual({ x: 250, y: 125 });
  });
});

describe("collision geometry", () => {
  it("hits collision elements in scene coordinates", () => {
    expect(hitTestScene(document, { x: 160, y: 100 })?.id).toBe("wall");
    expect(hitTestScene(document, { x: 20, y: 20 })).toBeUndefined();
    expect(hitTestScene(document, { x: 160, y: 100 }, { roles: ["visual"] })).toBeUndefined();
  });

  it("accounts for rotation around the element center", () => {
    const rotated = { ...rectangle, rotation: 90 };
    expect(pointInSceneElement(rotated, { x: 200, y: 0 })).toBe(false);
    expect(pointInSceneElement(rotated, { x: 200, y: 20 })).toBe(true);
  });

  it("uses the rendered smooth curve for freehand collision checks", () => {
    const freehand: FreehandElement = {
      id: "curve",
      name: "曲线路径",
      type: "freehand",
      role: "collision",
      visible: true,
      locked: false,
      opacity: 1,
      rotation: 0,
      style: { ...rectangle.style, strokeWidth: 2 },
      metadata: { label: "", notes: "", tags: [] },
      points: [
        { x: 0, y: 0 },
        { x: 50, y: 100 },
        { x: 100, y: 0 },
      ],
      smoothing: 1,
    };
    const sampled = sampleSmoothPoints(freehand.points, freehand.smoothing);

    expect(sampled.at(-1)).toEqual({ x: 100, y: 0 });
    expect(pointInSceneElement(freehand, { x: 43.75, y: 62.5 }, 1)).toBe(true);
  });
});

describe("asset links", () => {
  it("resolves relative image sources against the descriptor URL", () => {
    expect(
      resolveSceneAssetSource(
        "./assets/board.png",
        "https://assets.example.test/scenes/board.scene.json",
      ),
    ).toBe("https://assets.example.test/scenes/assets/board.png");
  });

  it("keeps embedded sources unchanged", () => {
    expect(resolveSceneAssetSource("data:image/png;base64,AA==", "https://example.test/")).toBe(
      "data:image/png;base64,AA==",
    );
  });
});
