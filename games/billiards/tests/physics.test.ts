import { describe, expect, it } from "vitest";

import type { BilliardsShot } from "../shared/actions.js";
import type { BilliardsBall } from "../shared/view.js";
import {
  billiardsSurfaceParameters,
  getBilliardsCoreInfo,
  predictBilliardsTrajectory,
  simulateBilliardsShot,
} from "../physics/index.js";
import { tableSpecFor } from "../shared/table.js";

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
    power: 62,
    tip: { x: 0, y: 0 },
    ...overrides,
  };
}

const mode = "chinese-eight-ball" as const;
const centreY = 1.26 / 2;

describe("billiards shot simulation", () => {
  it("maps the room friction coefficient across cloth and both cushion models", () => {
    const chinese = tableSpecFor("chinese-eight-ball");
    const snooker = tableSpecFor("snooker");
    const standardChinese = billiardsSurfaceParameters(chinese, 0.2);
    const standardSnooker = billiardsSurfaceParameters(snooker, 0.2);
    const fastChinese = billiardsSurfaceParameters(chinese, 0.12);
    const slowChinese = billiardsSurfaceParameters(chinese, 0.28);

    // 0.20 is the old simulator tuning, so existing rooms retain the same feel.
    expect(standardChinese).toMatchObject({
      cushionFriction: 0.12,
      cushionRestitution: chinese.cushionRestitution,
      cushionTangentialResponse: 0.075,
      rollingDeceleration: 0.16,
      sideSpinDamping: 0.72,
      slidingFriction: 0.2,
      spinConvergence: 1,
    });
    expect(standardSnooker.cushionRestitution).toBe(snooker.cushionRestitution);

    expect(fastChinese.rollingDeceleration).toBeLessThan(standardChinese.rollingDeceleration);
    expect(fastChinese.cushionFriction).toBeLessThan(standardChinese.cushionFriction);
    expect(fastChinese.cushionRestitution).toBeGreaterThan(standardChinese.cushionRestitution);
    expect(slowChinese.rollingDeceleration).toBeGreaterThan(standardChinese.rollingDeceleration);
    expect(slowChinese.cushionTangentialResponse).toBeGreaterThan(
      standardChinese.cushionTangentialResponse,
    );
    expect(slowChinese.cushionRestitution).toBeLessThan(standardChinese.cushionRestitution);
  });

  it("retains the legacy trajectory at the standard friction and varies distance and rebound", () => {
    const rollingBalls = [ball("cue", "cue", 0.55, centreY)];
    const legacy = simulateBilliardsShot({
      balls: rollingBalls,
      mode,
      shot: shot({ power: 8 }),
    });
    const standard = simulateBilliardsShot({
      balls: rollingBalls,
      mode,
      shot: shot({ power: 8 }),
      tableFriction: 0.2,
    });
    const fast = simulateBilliardsShot({
      balls: rollingBalls,
      mode,
      shot: shot({ power: 8 }),
      tableFriction: 0.12,
    });
    const slow = simulateBilliardsShot({
      balls: rollingBalls,
      mode,
      shot: shot({ power: 8 }),
      tableFriction: 0.28,
    });

    expect(standard).toEqual(legacy);
    expect(fast.durationMs).toBeGreaterThan(slow.durationMs);
    expect(fast.balls[0]!.x).toBeGreaterThan(slow.balls[0]!.x);

    const reboundBalls = [ball("cue", "cue", 2.08, centreY)];
    const fastRebound = simulateBilliardsShot({
      balls: reboundBalls,
      captureFrames: true,
      mode,
      shot: shot({ power: 24 }),
      tableFriction: 0.12,
    });
    const slowRebound = simulateBilliardsShot({
      balls: reboundBalls,
      captureFrames: true,
      mode,
      shot: shot({ power: 24 }),
      tableFriction: 0.28,
    });

    expect(fastRebound.railContactBallIds).toContain("cue");
    expect(slowRebound.railContactBallIds).toContain("cue");
    expect(fastRebound.balls[0]!.x).toBeLessThan(slowRebound.balls[0]!.x);
  });

  it("keeps the default spin convergence backward compatible and makes its rate adjustable", () => {
    const balls = [ball("cue", "cue", 0.55, centreY)];
    const omitted = simulateBilliardsShot({
      balls,
      captureFrames: true,
      mode,
      shot: shot({ tip: { x: 0, y: 0.75 }, power: 42 }),
      tableFriction: 0.24,
    });
    const explicitDefault = simulateBilliardsShot({
      balls,
      captureFrames: true,
      mode,
      shot: shot({ tip: { x: 0, y: 0.75 }, power: 42 }),
      spinConvergence: 1,
      tableFriction: 0.24,
    });
    const persistent = simulateBilliardsShot({
      balls,
      captureFrames: true,
      mode,
      shot: shot({ tip: { x: 0, y: 0.75 }, power: 42 }),
      spinConvergence: 0.5,
      tableFriction: 0.24,
    });
    const quick = simulateBilliardsShot({
      balls,
      captureFrames: true,
      mode,
      shot: shot({ tip: { x: 0, y: 0.75 }, power: 42 }),
      spinConvergence: 2,
      tableFriction: 0.24,
    });

    expect(explicitDefault).toEqual(omitted);
    const persistentFrame = persistent.frames!.find((frame) => frame.atMs >= 250);
    const quickFrame = quick.frames!.find((frame) => frame.atMs >= 250);
    expect(persistentFrame).toBeDefined();
    expect(quickFrame).toBeDefined();
    expect(persistentFrame!.balls[0]!.spinY).toBeGreaterThan(quickFrame!.balls[0]!.spinY);
    expect(persistent.durationMs).toBeGreaterThan(0);
    expect(quick.durationMs).toBeGreaterThan(0);
  });

  it("applies the same cloth-friction travel model to the full-size snooker table", () => {
    const snookerBalls = [ball("cue", "cue", 0.55, 1.778 / 2)];
    const fast = simulateBilliardsShot({
      balls: snookerBalls,
      mode: "snooker",
      shot: shot({ power: 8 }),
      tableFriction: 0.12,
    });
    const slow = simulateBilliardsShot({
      balls: snookerBalls,
      mode: "snooker",
      shot: shot({ power: 8 }),
      tableFriction: 0.28,
    });

    expect(fast.durationMs).toBeGreaterThan(slow.durationMs);
    expect(fast.balls[0]!.x).toBeGreaterThan(slow.balls[0]!.x);
  });

  it("is deterministic, finite, and replays optional frames", () => {
    const balls = [ball("cue", "cue", 0.45, centreY), ball("one", "solid", 1.2, centreY)];
    const first = simulateBilliardsShot({ balls, mode, shot: shot(), captureFrames: true });
    const second = simulateBilliardsShot({ balls, mode, shot: shot(), captureFrames: true });

    expect(first.checksum).toBe(second.checksum);
    expect(first.stateHash).toBe(second.stateHash);
    expect(first).toEqual(second);
    expect(first.physicsVersion).toMatch(/^pooltool-rs-event-v\d+$/);
    expect(first.stateHash).toMatch(/^[a-f0-9]{32}$/);
    expect(
      first.events.every(
        (event, index) => index === 0 || event.atSeconds >= first.events[index - 1]!.atSeconds,
      ),
    ).toBe(true);
    expect(first.frames?.[0]?.atMs).toBe(0);
    expect(first.frames?.at(-1)?.atMs).toBe(first.durationMs);
    for (const finalBall of first.balls) {
      expect(Number.isFinite(finalBall.x)).toBe(true);
      expect(Number.isFinite(finalBall.y)).toBe(true);
      expect(Number.isFinite(finalBall.rotation)).toBe(true);
    }
  });

  it("maps more power to a longer cue-ball travel", () => {
    const balls = [ball("cue", "cue", 0.55, centreY)];
    const low = simulateBilliardsShot({
      balls,
      mode,
      shot: shot({ angle: Math.PI / 2, power: 28 }),
    });
    const high = simulateBilliardsShot({
      balls,
      mode,
      shot: shot({ angle: Math.PI / 2, power: 80 }),
    });

    expect(high.durationMs).toBeGreaterThan(low.durationMs);
    expect(Math.abs(high.balls[0]!.y - balls[0]!.y)).toBeGreaterThan(
      Math.abs(low.balls[0]!.y - balls[0]!.y),
    );
  });

  it("resolves ball-ball contact and reports the first object ball", () => {
    const balls = [
      ball("cue", "cue", 0.45, centreY),
      ball("one", "solid", 0.92, centreY),
      ball("two", "stripe", 1.4, centreY + 0.08),
    ];
    const result = simulateBilliardsShot({
      balls,
      captureFrames: true,
      mode,
      shot: shot({ power: 56 }),
    });

    expect(result.firstContactBallId).toBe("one");
    expect(
      Math.max(
        ...result.frames!.map(
          (frame) => frame.balls.find((item) => item.id === "one")?.x ?? Number.NEGATIVE_INFINITY,
        ),
      ),
    ).toBeGreaterThan(0.92);
  });

  it("uses cushion restitution and records a rail contact", () => {
    const balls = [ball("cue", "cue", 0.6, centreY)];
    const result = simulateBilliardsShot({
      balls,
      mode,
      shot: shot({ angle: 0, power: 46 }),
      captureFrames: true,
    });

    expect(result.railContactBallIds).toContain("cue");
    expect(result.frames!.some((frame) => frame.balls[0]!.x > 2.45)).toBe(true);
  });

  it("captures a ball entering a corner pocket in deterministic order", () => {
    const balls = [ball("cue", "cue", 0.26, 0.26)];
    const result = simulateBilliardsShot({
      balls,
      mode,
      shot: shot({ angle: -Math.PI * 0.75, power: 40 }),
    });

    expect(result.pocketedBallIds).toEqual(["cue"]);
    expect(result.cueBallPotted).toBe(true);
    expect(result.balls[0]!.pocketed).toBe(true);
  });

  it("runs the same collision model on the full-size snooker table", () => {
    const snookerCentreY = 1.778 / 2;
    const balls = [
      ball("cue", "cue", 0.55, snookerCentreY),
      ball("red-1", "red", 1.05, snookerCentreY),
    ];
    const result = simulateBilliardsShot({
      balls,
      mode: "snooker",
      shot: shot({ power: 58 }),
    });

    expect(result.firstContactBallId).toBe("red-1");
    expect(result.balls.find((item) => item.id === "red-1")?.x).toBeGreaterThan(1.05);
    expect(result.balls.every((item) => item.x >= 0 && item.x <= 3.569)).toBe(true);
    expect(result.balls.every((item) => item.y >= 0 && item.y <= 1.778)).toBe(true);
  });

  it("changes rolling spin for top and back spin", () => {
    const balls = [ball("cue", "cue", 0.55, centreY)];
    const top = simulateBilliardsShot({
      balls,
      mode,
      shot: shot({ tip: { x: 0, y: 0.75 } }),
      captureFrames: true,
    });
    const back = simulateBilliardsShot({
      balls,
      mode,
      shot: shot({ tip: { x: 0, y: -0.75 } }),
      captureFrames: true,
    });
    const topSpin = top.frames![0]!.balls[0]!.spinY;
    const backSpin = back.frames![0]!.balls[0]!.spinY;

    expect(topSpin).toBeGreaterThan(0);
    expect(backSpin).toBeLessThan(0);
    expect(top.balls[0]!.x).not.toBe(back.balls[0]!.x);
  });

  it("bends in opposite directions for left and right english", () => {
    const balls = [ball("cue", "cue", 0.55, centreY)];
    const left = simulateBilliardsShot({
      balls,
      mode,
      shot: shot({ tip: { x: -0.8, y: 0 }, power: 48 }),
      captureFrames: true,
    });
    const right = simulateBilliardsShot({
      balls,
      mode,
      shot: shot({ tip: { x: 0.8, y: 0 }, power: 48 }),
      captureFrames: true,
    });
    const leftAtOneSecond = left.frames!.find((frame) => frame.atMs >= 500);
    const rightAtOneSecond = right.frames!.find((frame) => frame.atMs >= 500);

    expect(leftAtOneSecond).toBeDefined();
    expect(rightAtOneSecond).toBeDefined();
    expect(leftAtOneSecond!.balls[0]!.y).toBeGreaterThan(centreY);
    expect(rightAtOneSecond!.balls[0]!.y).toBeLessThan(centreY);
  });

  it("reduces horizontal impulse and produces a visible jump when the cue is elevated", () => {
    const balls = [ball("cue", "cue", 0.55, centreY)];
    const level = simulateBilliardsShot({
      balls,
      mode,
      shot: shot({ elevation: 0, power: 65 }),
      captureFrames: true,
    });
    const elevated = simulateBilliardsShot({
      balls,
      mode,
      shot: shot({ elevation: 55, power: 65 }),
      captureFrames: true,
    });
    const elevatedZ = Math.max(...elevated.frames!.map((frame) => frame.balls[0]!.z));

    expect(elevatedZ).toBeGreaterThan(0);
    const levelEarly = level.frames!.find((frame) => frame.atMs >= 250);
    const elevatedEarly = elevated.frames!.find((frame) => frame.atMs >= 250);
    expect(levelEarly).toBeDefined();
    expect(elevatedEarly).toBeDefined();
    expect(Math.abs(elevatedEarly!.balls[0]!.x - balls[0]!.x)).toBeLessThan(
      Math.abs(levelEarly!.balls[0]!.x - balls[0]!.x),
    );
  });

  it("lets an elevated cue ball clear an object ball and an open pocket while airborne", () => {
    const jumpingBalls = [ball("cue", "cue", 0.4, centreY), ball("one", "solid", 0.8, centreY)];
    const overBall = simulateBilliardsShot({
      balls: jumpingBalls,
      captureFrames: true,
      mode,
      shot: shot({ elevation: 55, power: 80 }),
    });
    const afterCrossing = overBall.frames!.find(
      (frame) => frame.atMs >= 100 && frame.balls[0]!.x > jumpingBalls[1]!.x,
    );

    expect(afterCrossing).toBeDefined();
    expect(afterCrossing!.balls[0]!.z).toBeGreaterThan(0.05715);
    expect(afterCrossing!.balls[1]!.x).toBeCloseTo(jumpingBalls[1]!.x, 6);
    expect(overBall.jumpedBallIds).toContain("one");

    const overPocket = simulateBilliardsShot({
      balls: [ball("cue", "cue", 0.26, 0.26)],
      captureFrames: true,
      mode,
      shot: shot({ angle: -Math.PI * 0.75, elevation: 55, power: 80 }),
    });
    const airbornePocketFrame = overPocket.frames!.find(
      (frame) => frame.atMs >= 50 && frame.atMs <= 150,
    );

    expect(airbornePocketFrame).toBeDefined();
    expect(airbornePocketFrame!.balls[0]!.z).toBeGreaterThan(0.05715 / 2);
    expect(airbornePocketFrame!.balls[0]!.pocketed).toBe(false);
  });

  it("does not report an elevated physical hit as jumping over the contacted ball", () => {
    const cueX = 0.4;
    const redX = 0.48;
    const result = simulateBilliardsShot({
      balls: [ball("cue", "cue", cueX, centreY), ball("red-1", "red", redX, centreY)],
      captureFrames: true,
      mode: "snooker",
      shot: shot({ elevation: 5, power: 80 }),
    });
    const maximumRelativeX = Math.max(
      ...result.frames!.map((frame) => frame.balls[0]!.x - frame.balls[1]!.x),
    );

    expect(result.firstContactBallIds).toEqual(["red-1"]);
    expect(maximumRelativeX).toBeLessThan(0);
    expect(result.jumpedBallIds).toEqual([]);
  });

  it("does not create a scoop jump from a lower-face cue-tip contact", () => {
    const result = simulateBilliardsShot({
      balls: [ball("cue", "cue", 0.55, centreY)],
      captureFrames: true,
      mode,
      shot: shot({ elevation: 70, power: 80, tip: { x: 0, y: -0.9 } }),
    });

    expect(Math.max(...result.frames!.map((frame) => frame.balls[0]!.z))).toBe(0);
  });

  it("does not report an elevated safety-boundary rebound as a cushion contact", () => {
    const result = simulateBilliardsShot({
      balls: [ball("cue", "cue", 2.35, centreY)],
      captureFrames: true,
      mode,
      shot: shot({ elevation: 55, power: 30, tip: { x: 0, y: 0.7 } }),
    });

    expect(Math.max(...result.frames!.map((frame) => frame.balls[0]!.x))).toBeGreaterThan(2.5);
    expect(Math.max(...result.frames!.map((frame) => frame.balls[0]!.z))).toBeLessThanOrEqual(
      0.05715 * 1.5,
    );
    expect(result.railContactBallIds).toEqual([]);
  });

  it("distinguishes cushion contacts before and after the first object-ball contact", () => {
    const result = simulateBilliardsShot({
      balls: [ball("cue", "cue", 0.4, centreY), ball("one", "solid", 0.8, centreY)],
      mode,
      shot: shot({ angle: Math.PI, power: 30 }),
    });

    expect(result.firstContactBallId).toBe("one");
    expect(result.railContactBallIds).toContain("cue");
    expect(result.postContactRailBallIds).toEqual([]);
  });

  it("reports every simultaneous first contact independently of input order", () => {
    const radius = 0.05715 / 2;
    const cue = ball("cue", "cue", 0.4, centreY);
    const upper = ball("one", "solid", 0.82, centreY - radius);
    const lower = ball("nine", "stripe", 0.82, centreY + radius);
    const first = simulateBilliardsShot({ balls: [cue, upper, lower], mode, shot: shot() });
    const reversed = simulateBilliardsShot({ balls: [cue, lower, upper], mode, shot: shot() });

    expect(first.firstContactBallIds).toEqual(["nine", "one"]);
    expect(reversed.firstContactBallIds).toEqual(first.firstContactBallIds);
    expect(reversed.stateHash).toBe(first.stateHash);
  });

  it("keeps frame capture out of the authoritative checksum", () => {
    const balls = [ball("cue", "cue", 0.45, centreY), ball("one", "solid", 1.2, centreY)];
    const authoritative = simulateBilliardsShot({ balls, mode, shot: shot() });
    const replay = simulateBilliardsShot({ balls, captureFrames: true, mode, shot: shot() });

    expect(replay.checksum).toBe(authoritative.checksum);
    expect(replay.stateHash).toBe(authoritative.stateHash);
    expect(replay.balls).toEqual(authoritative.balls);
  });

  it("reports the calibrated miscue boundary without treating it as a physics failure", () => {
    const balls = [ball("cue", "cue", 0.55, centreY)];
    const safe = simulateBilliardsShot({
      balls,
      mode,
      shot: shot({ tip: { x: 0.93, y: 0 } }),
    });
    const miscue = simulateBilliardsShot({
      balls,
      mode,
      shot: shot({ tip: { x: 0.95, y: 0 } }),
    });

    expect(safe.cueStrike.miscue).toBe(false);
    expect(miscue.cueStrike.miscue).toBe(true);
    expect(Math.abs(miscue.cueStrike.squirtRadians)).toBeGreaterThan(0);
    expect(miscue.durationMs).toBeGreaterThan(0);
  });

  it("uses the authoritative core for bounded deterministic AI trajectory prediction", () => {
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
