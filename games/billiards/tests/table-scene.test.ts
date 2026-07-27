import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  deriveBilliardsSceneCalibration,
  parseBilliardsTableScene,
  type BilliardsSceneCalibration,
} from "../shared/scene.js";

const sceneUrl = new URL("../scenes/chinese-eight-ball/table.json", import.meta.url);
const input = JSON.parse(readFileSync(sceneUrl, "utf8")) as unknown;
const scene = parseBilliardsTableScene("chinese-eight-ball", input);

describe("Chinese eight-ball scene asset", () => {
  it("uses the fixed table, boundary and hole names with a portable image", () => {
    expect(scene.table).toMatchObject({
      height: 1550,
      name: "table",
      role: "visual",
      source: "./table.png",
      type: "image",
      width: 2830,
      x: 0,
      y: 0,
    });
    expect(readFileSync(new URL(scene.table.source, sceneUrl)).subarray(1, 4).toString()).toBe(
      "PNG",
    );
    expect(scene.boundary).toMatchObject({
      closed: true,
      name: "boundary",
      role: "collision",
      type: "polyline",
    });
    expect(scene.boundary.points).toHaveLength(41);
    expect(scene.holes).toHaveLength(6);
    expect(scene.holes.every((hole) => hole.name === "hole" && hole.role === "collision")).toBe(
      true,
    );
  });

  it("calibrates authored scene units to the official playing dimensions", () => {
    const calibration = deriveBilliardsSceneCalibration(scene);

    expect(scene.document.canvas).toMatchObject({ height: 1550, width: 2830 });
    expect(calibration).toEqual({
      bottom: 1378.4328856435407,
      left: 166.01387826471466,
      right: 2650.9530074703275,
      top: 161.62538557934008,
    } satisfies BilliardsSceneCalibration);
    const scaleX = 2540 / (calibration.right - calibration.left);
    const scaleY = 1270 / (calibration.bottom - calibration.top);
    expect((calibration.right - calibration.left) * scaleX).toBeCloseTo(2540, 12);
    expect((calibration.bottom - calibration.top) * scaleY).toBeCloseTo(1270, 12);
    expect(scaleX).toBeCloseTo(1.0221578348327547, 12);
    expect(scaleY).toBeCloseTo(1.0437148028204897, 12);
  });

  it("rejects a reserved element with the wrong fixed name", () => {
    const malformed = structuredClone(input) as {
      elements: Array<{ name: string; type: string }>;
    };
    const table = malformed.elements.find((element) => element.type === "image");
    if (table === undefined) throw new Error("test scene is missing its table image");
    table.name = "background";

    expect(() => parseBilliardsTableScene("chinese-eight-ball", malformed)).toThrow(
      "名为 table 的图片元素",
    );
  });

  it("rejects a scene that changes the authoritative table scale", () => {
    const malformed = structuredClone(input) as {
      canvas: { width: number };
      elements: Array<{ name: string; type: string; width?: number }>;
    };
    malformed.canvas.width = 2831;
    const table = malformed.elements.find(
      (element) => element.type === "image" && element.name === "table",
    );
    if (table === undefined) throw new Error("test scene is missing its table image");
    table.width = 2831;

    expect(() => parseBilliardsTableScene("chinese-eight-ball", malformed)).toThrow(
      "2830 × 1550 scene-unit",
    );
  });
});
