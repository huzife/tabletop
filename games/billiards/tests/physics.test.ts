import { describe, expect, it } from "vitest";

import type { BilliardsShot } from "../shared/actions.js";
import type { BilliardsBall } from "../shared/view.js";
import {
  getBilliardsCoreInfo,
  getBilliardsTableSpec,
  predictBilliardsTrajectory,
  simulateBilliardsShot,
} from "../physics/index.js";

function ball(id: string, kind: BilliardsBall["kind"], x: number, y: number): BilliardsBall {
  return {
    id,
    kind,
    number: kind === "cue" || kind === "red" ? null : 1,
    pocketed: false,
    rotation: 0,
    value: kind === "black" || kind === "eight" ? 7 : 1,
    x,
    y,
  };
}

function shot(overrides: Partial<BilliardsShot> = {}): BilliardsShot {
  return {
    angle: 0,
    elevation: 0,
    nominatedColor: null,
    power: 50,
    tip: { x: 0, y: 0 },
    ...overrides,
  };
}

const mode = "chinese-eight-ball" as const;
const centreY = 1.27 / 2;

describe("Pooltool-compatible billiards core", () => {
  it("publishes the supplied table, ball, mouth and capture dimensions", () => {
    const pool = getBilliardsTableSpec(mode);
    expect(pool).toMatchObject({
      ballDiameter: 0.05715,
      ballMass: 0.170097,
      height: 1.27,
      outerHeight: 1.55,
      outerWidth: 2.83,
      width: 2.54,
    });
    expect(pool.pockets.map(({ mouthWidth }) => mouthWidth)).toEqual([
      0.084, 0.088, 0.084, 0.084, 0.088, 0.084,
    ]);
    for (const pocket of pool.pockets) {
      expect(pocket.captureRadius).toBeCloseTo(0.06879084312504863, 12);
    }
    expect(pool.pockets[0]).toMatchObject({ x: 0, y: 0 });
    expect(pool.pockets[0]?.captureX).toBeCloseTo(-0.02075736648250448, 12);
    expect(pool.pockets[0]?.captureY).toBeCloseTo(-0.03468153364632253, 12);
    expect(pool.pockets[1]).toMatchObject({ x: 2.54 / 2, y: 0 });
    expect(pool.pockets[1]?.captureX).toBeCloseTo(1.2718515960712096, 12);
    expect(pool.pockets[1]?.captureY).toBeCloseTo(-0.05555007824726151, 12);

    const snooker = getBilliardsTableSpec("snooker");
    expect(snooker).toMatchObject({
      ballDiameter: 0.0525,
      ballMass: 0.14,
      height: 1.778,
      outerHeight: 2.06,
      outerWidth: 3.85,
      width: 3.569,
    });
    expect(snooker.pockets[0]?.mouthWidth).toBe(0.086);
    expect(snooker.pockets[1]?.mouthWidth).toBe(0.089);
    expect(snooker.pockets[0]?.captureRadius).toBe(0.0889);
    expect(snooker.pockets[1]?.captureRadius).toBe(0.05319);
  });

  it("uses Pooltool's default cue speed and 2D strike resolver", () => {
    const result = simulateBilliardsShot({
      balls: [ball("cue", "cue", 0.55, centreY)],
      captureFrames: true,
      mode,
      shot: shot({ elevation: 55 }),
    });

    expect(result.cueStrike.cueSpeed).toBe(2);
    expect(result.cueStrike.jumpSpeed).toBe(0);
    expect(result.jumpedBallIds).toEqual([]);
    expect(Math.max(...result.frames!.map((frame) => frame.balls[0]!.z))).toBe(0);
    expect(result.events[0]).toMatchObject({
      atSeconds: 0,
      ballIds: ["cue"],
      kind: "stick_ball",
    });
  });

  it("is deterministic and resolves a single event at a time", () => {
    const balls = [
      ball("cue", "cue", 0.4, centreY),
      ball("one", "solid", 0.9, centreY),
      ball("two", "stripe", 1.3, centreY + 0.08),
    ];
    const input = { balls, captureFrames: true, mode, shot: shot({ power: 58 }) };
    const first = simulateBilliardsShot(input);
    const second = simulateBilliardsShot(input);

    expect(first).toEqual(second);
    expect(first.physicsVersion).toBe("tabletop-billiards-scene-v4");
    expect(first.stateHash).toMatch(/^[a-f0-9]{32}$/);
    expect(first.firstContactBallIds).toEqual(["one"]);
    expect(
      first.events.every(
        (event, index) => index === 0 || event.atSeconds >= first.events[index - 1]!.atSeconds,
      ),
    ).toBe(true);
    expect(first.frames?.[0]?.atMs).toBe(0);
    expect(first.frames?.at(-1)?.atMs).toBe(first.durationMs);
  });

  it("emits Pooltool motion-state transitions and reaches rest without a time cap", () => {
    const result = simulateBilliardsShot({
      balls: [ball("cue", "cue", 0.55, centreY)],
      captureFrames: true,
      mode,
      shot: shot({ angle: Math.PI / 2, power: 15 }),
    });

    expect(result.events.some(({ kind }) => kind === "sliding_rolling")).toBe(true);
    expect(
      result.events.some(
        ({ kind }) => kind === "rolling_stationary" || kind === "rolling_spinning",
      ),
    ).toBe(true);
    expect(result.frames?.at(-1)?.balls[0]?.state).toBe("stationary");
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("uses the frictional-inelastic ball collision and reports first contact", () => {
    const balls = [ball("cue", "cue", 0.45, centreY), ball("one", "solid", 0.95, centreY)];
    const result = simulateBilliardsShot({
      balls,
      captureFrames: true,
      mode,
      shot: shot({ power: 55 }),
    });

    expect(result.firstContactBallId).toBe("one");
    expect(result.events.some(({ kind }) => kind === "ball_ball")).toBe(true);
    expect(
      Math.max(
        ...result.frames!.map(
          (frame) => frame.balls.find(({ id }) => id === "one")?.x ?? Number.NEGATIVE_INFINITY,
        ),
      ),
    ).toBeGreaterThan(0.95);
  });

  it("resolves Pooltool linear/circular cushions and records rail contacts", () => {
    const result = simulateBilliardsShot({
      balls: [ball("cue", "cue", 0.55, centreY)],
      captureFrames: true,
      mode,
      shot: shot({ power: 42 }),
    });

    expect(result.railContactBallIds).toContain("cue");
    expect(result.events.some(({ kind }) => kind === "ball_cushion")).toBe(true);
    expect(
      result.events
        .filter(({ kind }) => kind === "ball_cushion")
        .every(({ geometryId }) => typeof geometryId === "string"),
    ).toBe(true);
    expect(result.events.find(({ kind }) => kind === "ball_cushion")?.geometryId).toMatch(
      /^scene-\d{2}$/,
    );
  });

  it("places a potted ball at Pooltool's canonical pocket centre", () => {
    const result = simulateBilliardsShot({
      balls: [ball("cue", "cue", 0.22, 0.22)],
      mode,
      shot: shot({ angle: -Math.PI * 0.75, power: 35 }),
    });
    const corner = getBilliardsTableSpec(mode).pockets[0]!;

    expect(result.pocketedBallIds).toEqual(["cue"]);
    expect(result.cueBallPotted).toBe(true);
    expect(result.balls[0]?.pocketed).toBe(true);
    expect(result.balls[0]?.x).toBeCloseTo(Number(corner.captureX.toFixed(6)), 12);
    expect(result.balls[0]?.y).toBeCloseTo(Number(corner.captureY.toFixed(6)), 12);
  });

  it.each(["chinese-eight-ball", "snooker"] as const)(
    "accepts a centre-line approach through all six %s mouths",
    (tableMode) => {
      const table = getBilliardsTableSpec(tableMode);
      for (const pocket of table.pockets) {
        const towardCentreX =
          pocket.kind === "side" ? 0 : pocket.x === 0 ? Math.SQRT1_2 : -Math.SQRT1_2;
        const towardCentreY =
          pocket.kind === "side"
            ? pocket.y === 0
              ? 1
              : -1
            : pocket.y === 0
              ? Math.SQRT1_2
              : -Math.SQRT1_2;
        const length = Math.hypot(towardCentreX, towardCentreY);
        const startX = pocket.x + (towardCentreX / length) * 0.24;
        const startY = pocket.y + (towardCentreY / length) * 0.24;
        const angle = Math.atan2(pocket.captureY - startY, pocket.captureX - startX);
        const result = simulateBilliardsShot({
          balls: [ball("cue", "cue", startX, startY)],
          mode: tableMode,
          shot: shot({ angle, power: 35 }),
        });

        expect(result.pocketedBallIds, pocket.id).toEqual(["cue"]);
        expect(result.balls[0]?.pocketed, pocket.id).toBe(true);
        expect(result.balls[0]?.x, pocket.id).toBeCloseTo(pocket.captureX, 6);
        expect(result.balls[0]?.y, pocket.id).toBeCloseTo(pocket.captureY, 6);
      }
    },
  );

  it("uses the snooker ball and cloth parameter set", () => {
    const centre = 1.778 / 2;
    const result = simulateBilliardsShot({
      balls: [ball("cue", "cue", 0.55, centre), ball("red-1", "red", 1.05, centre)],
      mode: "snooker",
      shot: shot({ power: 55 }),
    });

    expect(result.firstContactBallId).toBe("red-1");
    expect(result.balls.find(({ id }) => id === "red-1")!.x).toBeGreaterThan(1.05);
  });

  it("keeps frame capture out of authoritative hashes", () => {
    const balls = [ball("cue", "cue", 0.45, centreY), ball("one", "solid", 1.2, centreY)];
    const authoritative = simulateBilliardsShot({ balls, mode, shot: shot() });
    const replay = simulateBilliardsShot({ balls, captureFrames: true, mode, shot: shot() });

    expect(replay.checksum).toBe(authoritative.checksum);
    expect(replay.stateHash).toBe(authoritative.stateHash);
    expect(replay.balls).toEqual(authoritative.balls);
  });

  it("reports the product miscue boundary without changing Pooltool equations", () => {
    const balls = [ball("cue", "cue", 0.55, centreY)];
    const safe = simulateBilliardsShot({
      balls,
      mode,
      shot: shot({ tip: { x: 0.93, y: 0 } }),
    });
    const edge = simulateBilliardsShot({
      balls,
      mode,
      shot: shot({ tip: { x: 0.95, y: 0 } }),
    });

    expect(safe.cueStrike.miscue).toBe(false);
    expect(edge.cueStrike.miscue).toBe(true);
    expect(Math.abs(edge.cueStrike.squirtRadians)).toBeGreaterThan(0);
  });

  it("uses the authoritative core for bounded deterministic AI prediction", () => {
    const balls = [ball("cue", "cue", 0.45, centreY), ball("one", "solid", 1.2, centreY)];
    const input = { balls, maxFrames: 7, mode, shot: shot({ power: 48 }) };
    const first = predictBilliardsTrajectory(input);
    const second = predictBilliardsTrajectory(input);
    const simulation = simulateBilliardsShot({ ...input, captureFrames: true });
    const coreInfo = getBilliardsCoreInfo();

    expect(first).toEqual(second);
    expect(first.checksum).toBe(simulation.checksum);
    expect(first.stateHash).toBe(simulation.stateHash);
    expect(first.physicsVersion).toBe(coreInfo.physicsVersion);
    expect(coreInfo.rulesVersion).toMatch(/^tabletop-billiards-rules-v\d+$/);
    expect(first.paths.map(({ id }) => id)).toEqual(["cue", "one"]);
    expect(first.paths.every(({ points }) => points.length >= 2 && points.length <= 7)).toBe(true);
    expect(first.paths.every(({ points }) => points[0]?.atMs === 0)).toBe(true);
    expect(first.paths.every(({ points }) => points.at(-1)?.atMs === simulation.durationMs)).toBe(
      true,
    );
  });
});
