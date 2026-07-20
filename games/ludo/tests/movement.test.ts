import { describe, expect, it } from "vitest";

import { resolvePlaneAction } from "../server/index.js";
import {
  createFourPlayerState,
  createTwoPlayerState,
  planeId,
  setPlane,
  setPlaneOnGlobalMain,
} from "./helpers.js";

describe("ludo authoritative movement", () => {
  it("launches to APRON without spending the die as movement", () => {
    const state = createTwoPlayerState();
    const steps = resolvePlaneAction(state, planeId("red", 1), 5);

    expect(state.planes[0]?.position).toEqual({ region: "APRON" });
    expect(steps).toEqual([expect.objectContaining({ type: "launch", toCellId: "apron-red" })]);
  });

  it("reaches the red same-color cell on its second step from APRON before jumping", () => {
    const state = createTwoPlayerState();
    setPlane(state, planeId("red", 1), { region: "APRON" });

    const steps = resolvePlaneAction(state, planeId("red", 1), 2);

    expect(state.planes.find((plane) => plane.planeId === planeId("red", 1))?.position).toEqual({
      region: "MAIN_PATH",
      pathIndex: 5,
    });
    expect(steps).toContainEqual(expect.objectContaining({ type: "move", toCellId: "main-1" }));
    expect(steps).toContainEqual(
      expect.objectContaining({ type: "jump", fromCellId: "main-1", toCellId: "main-5" }),
    );
  });

  it("captures one enemy but allows own planes to stack", () => {
    const state = createTwoPlayerState();
    setPlane(state, planeId("red", 1), { region: "MAIN_PATH", pathIndex: 1 });
    setPlane(state, planeId("red", 2), { region: "MAIN_PATH", pathIndex: 2 });
    setPlaneOnGlobalMain(state, planeId("yellow", 1), 2);

    const steps = resolvePlaneAction(state, planeId("red", 1), 1);

    expect(
      state.planes.filter(
        (plane) =>
          plane.color === "red" &&
          plane.position.region === "MAIN_PATH" &&
          plane.position.pathIndex === 2,
      ),
    ).toHaveLength(2);
    expect(
      state.planes.find((plane) => plane.planeId === planeId("yellow", 1))?.position.region,
    ).toBe("BASE");
    expect(steps).toContainEqual(expect.objectContaining({ type: "capture", mutual: false }));
  });

  it("uses an exact enemy stack landing as mutual destruction", () => {
    const state = createTwoPlayerState();
    setPlane(state, planeId("red", 1), { region: "MAIN_PATH", pathIndex: 1 });
    setPlaneOnGlobalMain(state, planeId("yellow", 1), 2);
    setPlaneOnGlobalMain(state, planeId("yellow", 2), 2);

    const steps = resolvePlaneAction(state, planeId("red", 1), 1);

    expect(
      state.planes
        .filter((plane) =>
          [planeId("red", 1), planeId("yellow", 1), planeId("yellow", 2)].includes(plane.planeId),
        )
        .map((plane) => plane.position.region),
    ).toEqual(["BASE", "BASE", "BASE"]);
    expect(steps).toContainEqual(expect.objectContaining({ type: "capture", mutual: true }));
  });

  it("reaches a blockade transiently and retraces all remaining steps", () => {
    const state = createTwoPlayerState();
    setPlane(state, planeId("red", 1), { region: "MAIN_PATH", pathIndex: 0 });
    setPlaneOnGlobalMain(state, planeId("yellow", 1), 3);
    setPlaneOnGlobalMain(state, planeId("yellow", 2), 3);

    const steps = resolvePlaneAction(state, planeId("red", 1), 5);

    expect(state.planes.find((plane) => plane.planeId === planeId("red", 1))?.position).toEqual({
      region: "MAIN_PATH",
      pathIndex: 1,
    });
    expect(steps).toContainEqual(
      expect.objectContaining({ type: "bounce", reason: "blockade", atCellId: "main-3" }),
    );
    expect(steps.filter((step) => step.type === "move").map((step) => step.direction)).toEqual([
      "forward",
      "forward",
      "forward",
      "backward",
      "backward",
    ]);
  });

  it("can bounce repeatedly between APRON and the same entry blockade", () => {
    const state = createTwoPlayerState();
    setPlane(state, planeId("red", 1), { region: "APRON" });
    setPlaneOnGlobalMain(state, planeId("yellow", 1), 0);
    setPlaneOnGlobalMain(state, planeId("yellow", 2), 0);

    const steps = resolvePlaneAction(state, planeId("red", 1), 6);

    expect(state.planes.find((plane) => plane.planeId === planeId("red", 1))?.position).toEqual({
      region: "APRON",
    });
    expect(
      steps.filter((step) => step.type === "bounce" && step.reason === "blockade"),
    ).toHaveLength(3);
    expect(steps.filter((step) => step.type === "bounce" && step.reason === "apron")).toHaveLength(
      2,
    );
  });

  it("finishes exactly and reflects overshoot along the home lane", () => {
    const exact = createTwoPlayerState();
    setPlane(exact, planeId("red", 1), { region: "HOME_PATH", pathIndex: 4 });
    expect(resolvePlaneAction(exact, planeId("red", 1), 1)).toContainEqual(
      expect.objectContaining({ type: "finish" }),
    );
    expect(exact.planes.find((plane) => plane.planeId === planeId("red", 1))?.position.region).toBe(
      "FINISHED",
    );

    const overshoot = createTwoPlayerState();
    setPlane(overshoot, planeId("red", 1), { region: "HOME_PATH", pathIndex: 4 });
    const steps = resolvePlaneAction(overshoot, planeId("red", 1), 3);
    expect(overshoot.planes.find((plane) => plane.planeId === planeId("red", 1))?.position).toEqual(
      { region: "HOME_PATH", pathIndex: 3 },
    );
    expect(steps).toContainEqual(expect.objectContaining({ type: "bounce", reason: "finish" }));
  });

  it("jumps four cells, but cancels a jump that crosses an enemy stack", () => {
    const success = createTwoPlayerState();
    setPlane(success, planeId("red", 1), { region: "MAIN_PATH", pathIndex: 4 });
    expect(resolvePlaneAction(success, planeId("red", 1), 1)).toContainEqual(
      expect.objectContaining({ type: "jump", toCellId: "main-9" }),
    );
    expect(success.planes.find((plane) => plane.planeId === planeId("red", 1))?.position).toEqual({
      region: "MAIN_PATH",
      pathIndex: 9,
    });

    const blocked = createTwoPlayerState();
    setPlane(blocked, planeId("red", 1), { region: "MAIN_PATH", pathIndex: 4 });
    setPlaneOnGlobalMain(blocked, planeId("yellow", 1), 6);
    setPlaneOnGlobalMain(blocked, planeId("yellow", 2), 6);
    const blockedSteps = resolvePlaneAction(blocked, planeId("red", 1), 1);
    expect(blockedSteps).toContainEqual(
      expect.objectContaining({ type: "jump_cancelled", blockedCellId: "main-6" }),
    );
    expect(blocked.planes.find((plane) => plane.planeId === planeId("red", 1))?.position).toEqual({
      region: "MAIN_PATH",
      pathIndex: 5,
    });
  });

  it("treats a stack at the jump destination as mutual destruction", () => {
    const state = createTwoPlayerState();
    setPlane(state, planeId("red", 1), { region: "MAIN_PATH", pathIndex: 4 });
    setPlaneOnGlobalMain(state, planeId("yellow", 1), 9);
    setPlaneOnGlobalMain(state, planeId("yellow", 2), 9);

    const steps = resolvePlaneAction(state, planeId("red", 1), 1);
    expect(steps).toContainEqual(expect.objectContaining({ type: "jump" }));
    expect(steps).toContainEqual(expect.objectContaining({ type: "capture", mutual: true }));
    expect(state.planes.find((plane) => plane.planeId === planeId("red", 1))?.position.region).toBe(
      "BASE",
    );
  });

  it("flies after a successful jump and never performs a second jump", () => {
    const state = createTwoPlayerState();
    setPlane(state, planeId("red", 1), { region: "MAIN_PATH", pathIndex: 12 });

    const steps = resolvePlaneAction(state, planeId("red", 1), 1);

    expect(steps.map((step) => step.type)).toEqual(["move", "jump", "fly", "fly"]);
    expect(state.planes.find((plane) => plane.planeId === planeId("red", 1))?.position).toEqual({
      region: "MAIN_PATH",
      pathIndex: 29,
    });
  });

  it("flies first and then jumps when the die move lands directly on a flight entry", () => {
    const state = createTwoPlayerState();
    setPlane(state, planeId("red", 1), { region: "MAIN_PATH", pathIndex: 16 });
    setPlaneOnGlobalMain(state, planeId("yellow", 1), 19);
    setPlaneOnGlobalMain(state, planeId("yellow", 2), 19);

    const steps = resolvePlaneAction(state, planeId("red", 1), 1);

    expect(steps.map((step) => step.type)).toEqual(["move", "fly", "fly", "jump"]);
    expect(state.planes.find((plane) => plane.planeId === planeId("red", 1))?.position).toEqual({
      region: "MAIN_PATH",
      pathIndex: 33,
    });
  });

  it("captures one plane on the crossed home-lane cell and continues flying", () => {
    const state = createFourPlayerState();
    setPlane(state, planeId("red", 1), { region: "MAIN_PATH", pathIndex: 12 });
    setPlane(state, planeId("green", 1), { region: "HOME_PATH", pathIndex: 2 });

    const steps = resolvePlaneAction(state, planeId("red", 1), 1);

    expect(steps.map((step) => step.type)).toEqual(["move", "jump", "fly", "capture", "fly"]);
    expect(steps).toContainEqual({
      type: "capture",
      planeId: planeId("red", 1),
      atCellId: "home-green-2",
      capturedPlaneIds: [planeId("green", 1)],
      mutual: false,
    });
    expect(
      state.planes.find((plane) => plane.planeId === planeId("green", 1))?.position.region,
    ).toBe("BASE");
    expect(state.planes.find((plane) => plane.planeId === planeId("red", 1))?.position).toEqual({
      region: "MAIN_PATH",
      pathIndex: 29,
    });
  });

  it("stops at the crossed home-lane cell when an enemy stack causes mutual destruction", () => {
    const state = createFourPlayerState();
    setPlane(state, planeId("red", 1), { region: "MAIN_PATH", pathIndex: 12 });
    setPlane(state, planeId("green", 1), { region: "HOME_PATH", pathIndex: 2 });
    setPlane(state, planeId("green", 2), { region: "HOME_PATH", pathIndex: 2 });

    const steps = resolvePlaneAction(state, planeId("red", 1), 1);

    expect(steps.map((step) => step.type)).toEqual(["move", "jump", "fly", "capture"]);
    expect(steps.filter((step) => step.type === "fly")).toEqual([
      expect.objectContaining({ fromCellId: "main-17", toCellId: "home-green-2" }),
    ]);
    expect(steps).toContainEqual(
      expect.objectContaining({
        type: "capture",
        atCellId: "home-green-2",
        capturedPlaneIds: [planeId("green", 1), planeId("green", 2)],
        mutual: true,
      }),
    );
    expect(
      state.planes
        .filter((plane) =>
          [planeId("red", 1), planeId("green", 1), planeId("green", 2)].includes(plane.planeId),
        )
        .map((plane) => plane.position.region),
    ).toEqual(["BASE", "BASE", "BASE"]);
  });
});
