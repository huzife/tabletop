import { readFileSync } from "node:fs";

import { parseSceneJson } from "@tabletop/scene";
import { describe, expect, it } from "vitest";

import { deriveTableSceneCalibration } from "../web/table-scene.js";

const scene = parseSceneJson(
  readFileSync(new URL("../web/assets/chinese-eight-ball-table.json", import.meta.url), "utf8"),
);

describe("Chinese eight-ball scene asset", () => {
  it("keeps its image portable and publishes one boundary with six holes", () => {
    const image = scene.elements.find((element) => element.type === "image");
    const boundaries = scene.elements.filter(
      (element) => element.type === "polyline" && element.name === "boundary",
    );
    const holes = scene.elements.filter(
      (element) => element.type === "ellipse" && element.name === "hole",
    );

    expect(image?.source).toBe("./chinese-eight-ball-table-top-view.png");
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toMatchObject({ closed: true, role: "collision" });
    expect(boundaries[0]?.type === "polyline" ? boundaries[0].points : []).toHaveLength(41);
    expect(holes).toHaveLength(6);
    expect(holes.every((hole) => hole.role === "collision")).toBe(true);
  });

  it("derives the same playfield anchors used by native physics", () => {
    expect(deriveTableSceneCalibration(scene)).toEqual({
      bottom: 635.0214592274677,
      left: 79.1416309012875,
      right: 1197.7682403433475,
      top: 86.52360515021451,
    });
  });
});
