import { describe, expect, it } from "vitest";
import { seatIdSchema } from "@tabletop/protocol";

import { getBilliardsTableSpec } from "../physics/index.js";
import type { BilliardsBreakChoice } from "../shared/actions.js";
import type { BilliardsView } from "../shared/view.js";
import {
  pocketCircle,
  pocketMouthCircle,
  tableGeometry,
  tablePointFromClient,
} from "../web/canvas.js";
import {
  breakChoiceLabel,
  breakDecisionReasonLabel,
  canActOnDecision,
  defaultCuePlacement,
  isCuePlacementValid,
  noticeLabel,
  opponentAimPreview,
  outcomeLabel,
  phaseLabel,
} from "../web/GameView.js";
import {
  CUE_TIP_LIMIT,
  constrainCueTip,
  cueTipFromPointer,
  describeCueTip,
  nudgeCueTip,
  normalizeDegrees,
} from "../web/controls.js";

describe("billiards cue-tip control", () => {
  it("keeps pointer selections inside the legal circular face", () => {
    const tip = constrainCueTip(1, 1);

    expect(Math.hypot(tip.x, tip.y)).toBeCloseTo(CUE_TIP_LIMIT, 8);
    expect(tip.x).toBeCloseTo(tip.y, 8);
  });

  it("maps the visual top of the cue ball to positive follow spin", () => {
    const center = cueTipFromPointer(150, 150, {
      height: 100,
      left: 100,
      top: 100,
      width: 100,
    });
    const top = cueTipFromPointer(150, 100, {
      height: 100,
      left: 100,
      top: 100,
      width: 100,
    });

    expect(center).toEqual({ x: 0, y: 0 });
    expect(top.x).toBe(0);
    expect(top.y).toBeCloseTo(CUE_TIP_LIMIT, 8);
    expect(describeCueTip(top)).toBe("中线，高杆");
  });

  it("supports directional keyboard adjustment and Home reset", () => {
    const moved = nudgeCueTip(nudgeCueTip({ x: 0, y: 0 }, "ArrowRight"), "ArrowDown");

    expect(moved.x).toBeGreaterThan(0);
    expect(moved.y).toBeLessThan(0);
    expect(nudgeCueTip(moved, "Home")).toEqual({ x: 0, y: 0 });
    expect(nudgeCueTip(moved, "Escape")).toBe(moved);
  });

  it("normalizes displayed directions without losing a full turn", () => {
    expect(normalizeDegrees(-45)).toBe(315);
    expect(normalizeDegrees(765)).toBe(45);
  });
});

describe("billiards canvas coordinates", () => {
  it("contains the standard table while preserving its playing-surface ratio", () => {
    const table = getBilliardsTableSpec("chinese-eight-ball");
    const geometry = tableGeometry(900, 450, table);

    expect(geometry.playWidth / geometry.playHeight).toBeCloseTo(table.width / table.height, 8);
    expect(geometry.outerWidth / geometry.outerHeight).toBeCloseTo(
      table.outerWidth / table.outerHeight,
      8,
    );
    expect(geometry.railX / geometry.scale).toBeCloseTo((table.outerWidth - table.width) / 2, 8);
    expect(geometry.railY / geometry.scale).toBeCloseTo((table.outerHeight - table.height) / 2, 8);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.playLeft + geometry.playWidth).toBeLessThanOrEqual(900);
    expect(geometry.playTop + geometry.playHeight).toBeLessThanOrEqual(450);
  });

  it("converts scaled client coordinates back to table metres", () => {
    const table = getBilliardsTableSpec("snooker");
    const geometry = tableGeometry(1_000, 500, table);
    const bounds = { height: 250, left: 40, top: 30, width: 500 };
    const expected = { x: table.width * 0.25, y: table.height * 0.7 };
    const clientX =
      bounds.left +
      ((geometry.playLeft + expected.x * geometry.scale) / geometry.width) * bounds.width;
    const clientY =
      bounds.top +
      ((geometry.playTop + geometry.playHeight - expected.y * geometry.scale) / geometry.height) *
        bounds.height;

    expect(tablePointFromClient(clientX, clientY, bounds, geometry)).toEqual({
      x: expect.closeTo(expected.x, 8),
      y: expect.closeTo(expected.y, 8),
    });
  });

  it.each(["chinese-eight-ball", "snooker"] as const)(
    "projects every %s mouth and capture circle from the authoritative spec",
    (mode) => {
      const table = getBilliardsTableSpec(mode);
      const geometry = tableGeometry(1_000, 500, table);

      for (const pocket of table.pockets) {
        expect(pocketCircle(geometry, pocket)).toEqual({
          radius: pocket.captureRadius * geometry.scale,
          x: geometry.playLeft + pocket.captureX * geometry.scale,
          y: geometry.playTop + geometry.playHeight - pocket.captureY * geometry.scale,
        });
        expect(pocketMouthCircle(geometry, pocket)).toEqual({
          radius: (pocket.mouthWidth * geometry.scale) / 2,
          x: geometry.playLeft + pocket.x * geometry.scale,
          y: geometry.playTop + geometry.playHeight - pocket.y * geometry.scale,
        });
      }
    },
  );

  it("projects the lower-left physical origin to the lower-left of the canvas", () => {
    const table = getBilliardsTableSpec("snooker");
    const geometry = tableGeometry(1_000, 500, table);
    const lowerLeft = pocketCircle(geometry, table.pockets[0]!);
    const upperLeft = pocketCircle(geometry, table.pockets[3]!);

    expect(lowerLeft.x).toBeLessThan(geometry.playLeft);
    expect(lowerLeft.y).toBeGreaterThan(geometry.playTop + geometry.playHeight);
    expect(upperLeft.x).toBeLessThan(geometry.playLeft);
    expect(upperLeft.y).toBeLessThan(geometry.playTop);
  });

  it("restricts behind-line cue placement to the baulk side", () => {
    const view = viewFixture({ ballInHandZone: "behind-line", phase: "ball_in_hand" });
    const radius = view.table.ballDiameter / 2;

    expect(isCuePlacementValid({ x: 0.4, y: 0.63 }, view, radius)).toBe(true);
    expect(
      isCuePlacementValid({ x: (view.table.baulkLineX ?? 0) + 0.001, y: 0.63 }, view, radius),
    ).toBe(false);
    expect(noticeLabel(view)).toBe("母球：发球线后");
    expect(phaseLabel(view)).toBe("发球线后摆球");
    expect(defaultCuePlacement(view)).toEqual({ x: 0.3175, y: 0.635 });
  });

  it("provides a valid keyboard starting point inside the snooker D", () => {
    const table = getBilliardsTableSpec("snooker");
    const view = viewFixture({
      ballInHandZone: "d",
      mode: "snooker",
      phase: "ball_in_hand",
      table: {
        ...table,
        circularCushions: [...table.circularCushions],
        linearCushions: [...table.linearCushions],
        pockets: [...table.pockets],
        spots: [...table.spots],
      },
    });
    const point = defaultCuePlacement(view);

    expect(point).toBeDefined();
    expect(isCuePlacementValid(point!, view, table.ballDiameter / 2)).toBe(true);
  });
});

describe("chinese eight-ball decisions", () => {
  it("provides the official break decision labels and reasons", () => {
    const choices: BilliardsBreakChoice[] = [
      "accept-table",
      "take-line-in-hand",
      "spot-eight",
      "rerack-self",
      "rerack-opponent",
    ];
    expect(choices.map((choice) => breakChoiceLabel(choice))).toEqual([
      "接受台面",
      "线后手中球",
      "复位8号继续",
      "重摆·选择者开球",
      "重摆·原开球者开球",
    ]);
    expect(breakDecisionReasonLabel("illegal-break")).toBe("非法开球");
    expect(breakDecisionReasonLabel("break-foul")).toBe("开球犯规");
    expect(breakDecisionReasonLabel("eight-on-break")).toBe("开球进 8 号球");
    expect(breakDecisionReasonLabel("eight-on-break-foul")).toBe("开球进 8 号球且犯规");
    expect(breakChoiceLabel("spot-eight", "eight-on-break-foul")).toBe("复位8号·线后手中球");
  });

  it("only enables a legal decision for its designated chooser", () => {
    const chooserSeatId = seatIdSchema.parse("seat-1");
    const otherSeatId = seatIdSchema.parse("seat-2");
    const decision: Extract<
      NonNullable<BilliardsView["pendingDecision"]>,
      { type: "break-choice" }
    > = {
      breakerSeatId: otherSeatId,
      chooserSeatId,
      choices: ["accept-table", "take-line-in-hand"],
      reason: "illegal-break",
      type: "break-choice",
    };
    const view = viewFixture({
      activeSeatId: chooserSeatId,
      legalActions: {
        canChooseDecidingBlack: false,
        canChooseGroup: false,
        canPlaceCue: false,
        canResign: true,
        canResolveBreak: true,
        canShoot: false,
      },
      pendingDecision: decision,
      phase: "decision",
      viewerSeatId: chooserSeatId,
    });

    expect(canActOnDecision(view, decision, false)).toBe(true);
    expect(canActOnDecision(view, decision, true)).toBe(false);
    expect(canActOnDecision({ ...view, viewerSeatId: otherSeatId }, decision, false)).toBe(false);
    expect(
      canActOnDecision(
        { ...view, legalActions: { ...view.legalActions, canResolveBreak: false } },
        decision,
        false,
      ),
    ).toBe(false);
    expect(phaseLabel(view)).toBe("选择开球处理");
    expect(noticeLabel(view)).toBe("待裁定：非法开球");
  });

  it("labels and authorizes the deciding-black starter choice", () => {
    const chooserSeatId = seatIdSchema.parse("seat-1");
    const decision: Extract<
      NonNullable<BilliardsView["pendingDecision"]>,
      { type: "deciding-black-choice" }
    > = {
      chooserSeatId,
      choices: ["play-self", "defer"],
      type: "deciding-black-choice",
    };
    const view = viewFixture({
      activeSeatId: chooserSeatId,
      legalActions: {
        canChooseDecidingBlack: true,
        canChooseGroup: false,
        canPlaceCue: false,
        canResign: true,
        canResolveBreak: false,
        canShoot: false,
      },
      mode: "snooker",
      pendingDecision: decision,
      phase: "decision",
      viewerSeatId: chooserSeatId,
    });

    expect(canActOnDecision(view, decision, false)).toBe(true);
    expect(phaseLabel(view)).toBe("选择决胜先手");
    expect(noticeLabel(view)).toBe("待选择：决胜黑球先手");
  });
});

describe("billiards result labels", () => {
  it("identifies the winner for both a player and a spectator", () => {
    const firstSeat = seatIdSchema.parse("seat-1");
    const secondSeat = seatIdSchema.parse("seat-2");
    const baseView = viewFixture({
      activeSeatId: null,
      outcome: { reason: "eight-ball" as const, winnerSeatId: firstSeat },
      phase: "ended" as const,
      players: [
        { active: false, group: "solids" as const, score: 7, seatId: firstSeat },
        { active: false, group: "stripes" as const, score: 3, seatId: secondSeat },
      ],
      shotNumber: 12,
      viewerSeatId: firstSeat,
    });

    expect(outcomeLabel(baseView)).toContain("你获胜");
    expect(outcomeLabel({ ...baseView, viewerSeatId: null })).toContain("玩家 1 获胜");
  });
});

describe("billiards solo practice labels", () => {
  it("shows competitive foul notices and identifies the active controlled position", () => {
    const firstSeat = seatIdSchema.parse("seat-1");
    const secondSeat = seatIdSchema.parse("seat-2");
    const view = viewFixture({
      activeSeatId: secondSeat,
      lastShot: {
        foulCode: "NO_BALL_CONTACT",
        points: 0,
        pottedBallIds: [],
        seatId: firstSeat,
      },
      players: [
        { active: false, group: "solids", score: 1, seatId: firstSeat },
        { active: true, group: "stripes", score: 0, seatId: secondSeat },
      ],
      practice: true,
    });

    expect(phaseLabel(view)).toBe("轮到位置 2");
    expect(noticeLabel(view)).toBe("犯规：未碰到球");
  });

  it("lets the sole player act on a decision assigned to either position", () => {
    const secondSeat = seatIdSchema.parse("seat-2");
    const decision = {
      chooserSeatId: secondSeat,
      groups: ["solids", "stripes"],
      type: "choose-group",
    } as const;
    const view = viewFixture({
      activeSeatId: secondSeat,
      legalActions: {
        canChooseDecidingBlack: false,
        canChooseGroup: true,
        canPlaceCue: false,
        canResign: true,
        canResolveBreak: false,
        canShoot: false,
      },
      pendingDecision: decision,
      phase: "decision",
      practice: true,
    });

    expect(canActOnDecision(view, decision, false)).toBe(true);
    expect(phaseLabel(view)).toBe("选择球组");
    expect(noticeLabel(view)).toBe("待选择：全色或花色");
  });

  it("uses the online in-hand labels after a scratch", () => {
    const view = viewFixture({
      ballInHandZone: "anywhere",
      phase: "ball_in_hand",
      practice: true,
      shotNumber: 2,
    });

    expect(phaseLabel(view)).toBe("摆放母球");
    expect(noticeLabel(view)).toBe("母球：自由球");
  });
});

describe("billiards opponent aim preview", () => {
  it("accepts only the current opponent's preview for the current shot", () => {
    const activeSeatId = seatIdSchema.parse("seat-1");
    const viewerSeatId = seatIdSchema.parse("seat-2");
    const view = viewFixture({ activeSeatId, shotNumber: 4, viewerSeatId });
    const transient = {
      event: {
        angle: Math.PI / 3,
        elevation: 18,
        power: 200,
        shotNumber: 4,
        tip: { x: 0.35, y: -0.2 },
        type: "billiards.aim-preview",
      },
      senderSeatId: activeSeatId,
      serverTime: "2026-01-01T00:00:00.000Z",
    } as const;

    expect(opponentAimPreview(view, transient)).toMatchObject({
      elevation: 18,
      power: 200,
      tip: { x: 0.35, y: -0.2 },
    });
    expect(opponentAimPreview({ ...view, shotNumber: 5 }, transient)).toBeNull();
    expect(opponentAimPreview({ ...view, viewerSeatId: activeSeatId }, transient)).toBeNull();
    expect(opponentAimPreview({ ...view, practice: true }, transient)).toBeNull();
    expect(opponentAimPreview(view, transient, true)).toBeNull();
  });

  it("rejects malformed or non-active-seat transient data", () => {
    const view = viewFixture({ viewerSeatId: seatIdSchema.parse("seat-2") });
    const base = {
      senderSeatId: seatIdSchema.parse("seat-1"),
      serverTime: "2026-01-01T00:00:00.000Z",
    };

    expect(
      opponentAimPreview(view, {
        ...base,
        event: {
          angle: 0,
          elevation: 0,
          power: 200.001,
          shotNumber: 0,
          tip: { x: 0, y: 0 },
          type: "billiards.aim-preview",
        },
      }),
    ).toBeNull();
    expect(
      opponentAimPreview(view, {
        ...base,
        event: {
          angle: 0,
          elevation: 0,
          power: 50,
          shotNumber: 0,
          tip: { x: 0, y: 0 },
          type: "billiards.aim-preview",
        },
        senderSeatId: seatIdSchema.parse("seat-2"),
      }),
    ).toBeNull();
  });
});

function viewFixture(overrides: Partial<BilliardsView> = {}): BilliardsView {
  const firstSeat = seatIdSchema.parse("seat-1");
  const secondSeat = seatIdSchema.parse("seat-2");
  const table = getBilliardsTableSpec("chinese-eight-ball");
  return {
    activeSeatId: firstSeat,
    ballInHandZone: null,
    balls: [],
    breakShot: false,
    fixedShotPower: 100,
    lastShot: null,
    legalActions: {
      canChooseDecidingBlack: false,
      canChooseGroup: false,
      canPlaceCue: false,
      canResign: true,
      canResolveBreak: false,
      canShoot: true,
    },
    mode: "chinese-eight-ball",
    outcome: null,
    pendingDecision: null,
    phase: "aiming",
    practice: false,
    players: [
      { active: true, group: "open", score: 0, seatId: firstSeat },
      { active: false, group: "open", score: 0, seatId: secondSeat },
    ],
    shotNumber: 0,
    snookerOn: null,
    table: {
      ...table,
      circularCushions: [...table.circularCushions],
      linearCushions: [...table.linearCushions],
      pockets: [...table.pockets],
      spots: [...table.spots],
    },
    viewerSeatId: firstSeat,
    ...overrides,
  };
}
