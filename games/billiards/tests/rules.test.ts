import { GameRuleError } from "@tabletop/game-sdk/server";
import {
  createTestActionContextV1,
  createTestCreateMatchContextV1,
  createTestProjectionContextV1,
  createTestSystemEventContextV1,
} from "@tabletop/game-sdk/testing";
import { seatIdSchema } from "@tabletop/protocol";
import { describe, expect, it } from "vitest";

import {
  BilliardsCoreError,
  createBilliardsCoreMatch,
  reduceBilliardsCoreAction,
  simulateBilliardsShot,
} from "../physics/index.js";
import {
  createBilliardsMatch,
  handleBilliardsAction,
  handleBilliardsSystemEvent,
  projectBilliardsView,
} from "../server/engine.js";
import { billiardsServerModule } from "../server/module.js";
import type {
  AdjudicatedBilliardsShot,
  BallInHandZone,
  BilliardsMatchState,
  BilliardsSimulationResult,
  ShotAdjudicationInput,
} from "../server/state.js";
import type { BilliardsShot } from "../shared/actions.js";
import {
  billiardsSettings,
  type BilliardsMode,
  type BilliardsSettings,
} from "../shared/settings.js";
import { tableSpecFor } from "../shared/table.js";
import { billiardsDisplayEventSchema, billiardsViewSchema } from "../shared/view.js";

const seat1 = seatIdSchema.parse("seat-1");
const seat2 = seatIdSchema.parse("seat-2");
const seats = [seat1, seat2] as const;

function reduceShot(
  input: Readonly<ShotAdjudicationInput>,
  chooserIndex = 1,
): AdjudicatedBilliardsShot {
  try {
    return reduceBilliardsCoreAction({
      action: { shot: input.shot, type: "billiards.shoot" },
      actorSeatId: input.actorSeatId,
      decidingBlackChooserIndex: chooserIndex,
      simulation: input.simulation,
      state: input.state,
    });
  } catch (error) {
    if (error instanceof BilliardsCoreError) throw new GameRuleError(error.code);
    throw error;
  }
}

function adjudicateChineseEightBallShot(
  input: Readonly<ShotAdjudicationInput>,
): AdjudicatedBilliardsShot {
  return reduceShot(input);
}

function adjudicateSnookerShot(
  input: Readonly<ShotAdjudicationInput>,
  chooserIndex = 1,
): AdjudicatedBilliardsShot {
  return reduceShot(input, chooserIndex);
}

function adjudicatePracticeShot(input: Readonly<ShotAdjudicationInput>): AdjudicatedBilliardsShot {
  return reduceShot(input);
}

function settings(mode: BilliardsMode): BilliardsSettings {
  return { ...billiardsSettings.defaultValue, mode };
}

function state(mode: BilliardsMode): BilliardsMatchState {
  return createBilliardsCoreMatch(settings(mode), seats);
}

function practiceState(mode: BilliardsMode): BilliardsMatchState {
  return createBilliardsCoreMatch(settings(mode), [seat1]);
}

function createInitialBilliardsState(
  matchSettings: Readonly<BilliardsSettings>,
  seatIds: readonly string[],
): BilliardsMatchState {
  return createBilliardsCoreMatch(matchSettings, seatIds);
}

function createChineseEightBallRack() {
  return createBilliardsCoreMatch(settings("chinese-eight-ball"), seats).balls;
}

function createSnookerRack() {
  return createBilliardsCoreMatch(settings("snooker"), seats).balls;
}

function checkCuePlacement(
  match: Readonly<BilliardsMatchState>,
  x: number,
  y: number,
  _zone?: BallInHandZone,
): { readonly ok: true } | { readonly ok: false; readonly ruleCode: string } {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, ruleCode: "CUE_OUT_OF_BOUNDS" };
  }
  try {
    reduceBilliardsCoreAction({
      action: { type: "billiards.place-cue", x, y },
      actorSeatId: match.activeSeatId ?? "",
      state: match,
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof BilliardsCoreError) {
      return { ok: false, ruleCode: error.code };
    }
    throw error;
  }
}

function shot(nominatedColor: BilliardsShot["nominatedColor"] = null): BilliardsShot {
  return {
    angle: 0,
    elevation: 0,
    nominatedColor,
    power: 50,
    tip: { x: 0, y: 0 },
  };
}

function simulation(
  match: Readonly<BilliardsMatchState>,
  options: {
    readonly first?: string | null;
    readonly firsts?: readonly string[];
    readonly jumped?: readonly string[];
    readonly potted?: readonly string[];
    readonly postContactRails?: readonly string[];
    readonly rails?: readonly string[];
  } = {},
): BilliardsSimulationResult {
  const potted = options.potted ?? [];
  const pottedSet = new Set(potted);
  const first = options.first === undefined ? "1" : options.first;
  const firsts = options.firsts ?? (first === null ? [] : [first]);
  return {
    balls: match.balls.map((ball) =>
      pottedSet.has(ball.id) ? { ...ball, pocketed: true } : { ...ball },
    ),
    checksum: "1234abcd",
    cueBallPotted: potted.includes("cue"),
    durationMs: 1_000,
    firstContactBallId: firsts[0] ?? null,
    firstContactBallIds: firsts,
    jumpedBallIds: options.jumped ?? [],
    pocketedBallIds: potted,
    postContactRailBallIds: options.postContactRails ?? options.rails ?? [],
    railContactBallIds: options.rails ?? [],
  };
}

function readyToShoot(match: Readonly<BilliardsMatchState>): BilliardsMatchState {
  return {
    ...match,
    ballInHandZone: null,
    balls: match.balls.map((ball) => (ball.kind === "cue" ? { ...ball, pocketed: false } : ball)),
    phase: "aiming",
  };
}

function withEightBallGroups(
  match: Readonly<BilliardsMatchState>,
  options: { readonly clearSolids?: boolean } = {},
): BilliardsMatchState {
  const ready = readyToShoot(match);
  return {
    ...ready,
    balls: ready.balls.map((ball) =>
      options.clearSolids && ball.kind === "solid" ? { ...ball, pocketed: true } : ball,
    ),
    breakShot: false,
    players: [
      { group: "solids", score: options.clearSolids ? 7 : 0, seatId: seat1 },
      { group: "stripes", score: 0, seatId: seat2 },
    ],
  };
}

function withSnookerScores(
  match: Readonly<BilliardsMatchState>,
  first: number,
  second: number,
): BilliardsMatchState {
  return {
    ...match,
    players: [
      { group: null, score: first, seatId: seat1 },
      { group: null, score: second, seatId: seat2 },
    ],
  };
}

describe("standard billiards setups", () => {
  it("keeps only the rule mode in room settings", () => {
    const parsed = billiardsSettings.schema.parse({ mode: "snooker" });

    expect(parsed).toEqual({ mode: "snooker" });
    expect(
      billiardsSettings.schema.safeParse({ mode: "snooker", tableFriction: 0.2 }).success,
    ).toBe(false);
    expect(
      billiardsSettings.schema.safeParse({ mode: "snooker", spinConvergence: 1 }).success,
    ).toBe(false);
    expect(billiardsSettings.summarize(parsed)).toEqual([{ label: "模式", value: "斯诺克" }]);
  });

  it("builds a legal deterministic Chinese eight-ball rack", () => {
    const balls = createChineseEightBallRack();
    const table = tableSpecFor("chinese-eight-ball");
    const foot = table.spots.find(({ id }) => id === "foot");
    if (!foot) throw new Error("missing foot spot");

    expect(balls).toHaveLength(16);
    expect(balls.filter(({ kind }) => kind === "solid")).toHaveLength(7);
    expect(balls.filter(({ kind }) => kind === "stripe")).toHaveLength(7);
    const eight = balls.find(({ kind }) => kind === "eight");
    expect(eight?.x).toBeCloseTo(foot.x + Math.sqrt(3) * table.ballDiameter);
    expect(eight?.y).toBeCloseTo(foot.y);

    const rearX = Math.max(...balls.filter(({ kind }) => kind !== "cue").map(({ x }) => x));
    const corners = balls
      .filter((ball) => Math.abs(ball.x - rearX) < 1e-9)
      .sort((a, b) => a.y - b.y);
    expect([corners[0]?.kind, corners.at(-1)?.kind].sort()).toEqual(["solid", "stripe"]);
  });

  it("places 15 reds, six colors, and the cue ball inside the snooker D", () => {
    const balls = createSnookerRack();
    const table = tableSpecFor("snooker");
    const cue = balls.find(({ kind }) => kind === "cue");
    const brown = table.spots.find(({ id }) => id === "brown");
    const pink = balls.find(({ kind }) => kind === "pink");
    const apexRed = balls.find(({ id }) => id === "red-1");

    expect(balls).toHaveLength(22);
    expect(balls.filter(({ kind }) => kind === "red")).toHaveLength(15);
    for (const spot of table.spots) {
      const color = balls.find(({ kind }) => kind === spot.id);
      expect(color?.x).toBeCloseTo(spot.x);
      expect(color?.y).toBeCloseTo(spot.y);
    }
    if (!cue || !brown || !pink || !apexRed || table.dRadius === null) {
      throw new Error("incomplete snooker table");
    }
    expect(cue.x).toBeLessThanOrEqual(brown.x);
    expect(Math.hypot(cue.x - brown.x, cue.y - brown.y)).toBeLessThanOrEqual(table.dRadius);
    expect(Math.hypot(apexRed.x - pink.x, apexRed.y - pink.y)).toBeCloseTo(
      table.ballDiameter + 0.0005,
      8,
    );
  });

  it("starts each mode with the cue ball in hand in its required opening zone", () => {
    expect(state("chinese-eight-ball")).toMatchObject({
      ballInHandZone: "behind-line",
      phase: "ball_in_hand",
    });
    expect(state("snooker")).toMatchObject({
      ballInHandZone: "d",
      phase: "ball_in_hand",
    });
  });
});

describe("cue-ball placement", () => {
  it("rejects cushions, pocket mouths, and overlaps for an anywhere free ball", () => {
    const initial = state("chinese-eight-ball");
    const inHand: BilliardsMatchState = {
      ...initial,
      ballInHandZone: "anywhere",
      phase: "ball_in_hand",
    };
    const table = tableSpecFor("chinese-eight-ball");
    const object = inHand.balls.find(({ kind }) => kind === "solid");
    if (!object) throw new Error("missing object ball");

    expect(checkCuePlacement(inHand, 0, table.height / 2)).toEqual({
      ok: false,
      ruleCode: "CUE_OUT_OF_BOUNDS",
    });
    expect(checkCuePlacement(inHand, Number.NaN, table.height / 2)).toEqual({
      ok: false,
      ruleCode: "CUE_OUT_OF_BOUNDS",
    });
    expect(checkCuePlacement(inHand, table.ballDiameter / 2, table.ballDiameter / 2)).toEqual({
      ok: true,
    });
    expect(checkCuePlacement(inHand, object.x, object.y)).toEqual({
      ok: false,
      ruleCode: "CUE_OVERLAPS_BALL",
    });
    expect(checkCuePlacement(inHand, table.width / 2, table.height / 4)).toEqual({ ok: true });
  });

  it("limits a snooker in-hand cue ball to the D", () => {
    const initial = state("snooker");
    const inHand: BilliardsMatchState = {
      ...initial,
      ballInHandZone: "d",
      phase: "ball_in_hand",
    };
    const table = tableSpecFor("snooker");
    const line = table.baulkLineX;
    if (line === null || table.dRadius === null) throw new Error("missing D");

    expect(checkCuePlacement(inHand, line - table.dRadius / 2, table.height / 2, "d")).toEqual({
      ok: true,
    });
    expect(checkCuePlacement(inHand, line + 0.01, table.height / 2, "d")).toEqual({
      ok: false,
      ruleCode: "CUE_OUTSIDE_D",
    });
  });

  it("limits a Heyball opening or break-foul cue ball to behind the baulk line", () => {
    const inHand = state("chinese-eight-ball");
    const table = tableSpecFor("chinese-eight-ball");
    const line = table.baulkLineX;
    if (line === null) throw new Error("missing baulk line");

    expect(checkCuePlacement(inHand, line, table.height / 4, "behind-line")).toEqual({ ok: true });
    expect(checkCuePlacement(inHand, line + 0.001, table.height / 4, "behind-line")).toEqual({
      ok: false,
      ruleCode: "CUE_OUTSIDE_BEHIND_LINE",
    });
  });
});

describe("Chinese eight-ball rules", () => {
  it("offers accept or either rerack after an otherwise clean illegal break", () => {
    const initial = readyToShoot(state("chinese-eight-ball"));
    const illegal = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(initial, { first: "1", postContactRails: ["1", "2", "3"] }),
      state: initial,
    });
    expect(illegal).toMatchObject({
      foulCode: "ILLEGAL_BREAK",
      state: {
        activeSeatId: seat2,
        ballInHandZone: null,
        pendingDecision: {
          breakerSeatId: seat1,
          chooserSeatId: seat2,
          choices: ["accept-table", "rerack-self", "rerack-opponent"],
          reason: "illegal-break",
          type: "break-choice",
        },
        phase: "decision",
        shotNumber: 1,
      },
    });
    const decisionView = projectBilliardsView(createTestProjectionContextV1(), illegal.state, {
      kind: "player",
      seatId: seat2,
    });
    expect(decisionView.legalActions).toMatchObject({
      canChooseGroup: false,
      canResolveBreak: true,
      canShoot: false,
    });
    expect(decisionView.pendingDecision).toEqual(illegal.state.pendingDecision);
    expectRuleCode(
      () =>
        handleBilliardsAction(
          createTestActionContextV1({ actor: { kind: "human", seatId: seat1 } }),
          illegal.state,
          { choice: "accept-table", type: "billiards.break-choice" },
        ),
      "NOT_YOUR_TURN",
    );
    expectRuleCode(
      () =>
        handleBilliardsAction(
          createTestActionContextV1({ actor: { kind: "human", seatId: seat2 } }),
          illegal.state,
          { choice: "take-line-in-hand", type: "billiards.break-choice" },
        ),
      "BREAK_CHOICE_NOT_AVAILABLE",
    );

    const accept = handleBilliardsAction(
      createTestActionContextV1({ actor: { kind: "human", seatId: seat2 } }),
      illegal.state,
      { choice: "accept-table", type: "billiards.break-choice" },
    );
    expect(accept.state).toMatchObject({
      activeSeatId: seat2,
      ballInHandZone: null,
      pendingDecision: null,
      phase: "aiming",
      shotNumber: 1,
    });

    const selfRerack = handleBilliardsAction(
      createTestActionContextV1({ actor: { kind: "human", seatId: seat2 } }),
      illegal.state,
      { choice: "rerack-self", type: "billiards.break-choice" },
    );
    expect(selfRerack.state).toMatchObject({
      activeSeatId: seat2,
      ballInHandZone: "behind-line",
      breakShot: true,
      pendingDecision: null,
      phase: "ball_in_hand",
      shotNumber: 1,
    });
    expect(selfRerack.state.players).toMatchObject([
      { group: "open", score: 0 },
      { group: "open", score: 0 },
    ]);

    const opponentRerack = handleBilliardsAction(
      createTestActionContextV1({ actor: { kind: "human", seatId: seat2 } }),
      illegal.state,
      { choice: "rerack-opponent", type: "billiards.break-choice" },
    );
    expect(opponentRerack.state).toMatchObject({
      activeSeatId: seat1,
      ballInHandZone: "behind-line",
      breakShot: true,
      phase: "ball_in_hand",
      shotNumber: 1,
    });
  });

  it("offers line-in-hand or either rerack after an ordinary break foul", () => {
    const initial = readyToShoot(state("chinese-eight-ball"));
    const foul = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(initial, { first: "1", potted: ["cue"] }),
      state: initial,
    });
    expect(foul.state.pendingDecision).toMatchObject({
      choices: ["take-line-in-hand", "rerack-self", "rerack-opponent"],
      reason: "break-foul",
    });

    const take = handleBilliardsAction(
      createTestActionContextV1({ actor: { kind: "human", seatId: seat2 } }),
      foul.state,
      { choice: "take-line-in-hand", type: "billiards.break-choice" },
    );
    expect(take.state).toMatchObject({
      activeSeatId: seat2,
      ballInHandZone: "behind-line",
      phase: "ball_in_hand",
    });
    expect(take.state.balls.find(({ kind }) => kind === "cue")?.pocketed).toBe(true);

    for (const [choice, breaker] of [
      ["rerack-self", seat2],
      ["rerack-opponent", seat1],
    ] as const) {
      const reracked = handleBilliardsAction(
        createTestActionContextV1({ actor: { kind: "human", seatId: seat2 } }),
        foul.state,
        { choice, type: "billiards.break-choice" },
      );
      expect(reracked.state).toMatchObject({
        activeSeatId: breaker,
        ballInHandZone: "behind-line",
        breakShot: true,
        phase: "ball_in_hand",
        shotNumber: 1,
      });
    }
  });

  it("offers spot-or-rerack after a clean eight on the break", () => {
    const initial = readyToShoot(state("chinese-eight-ball"));
    const eight = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(initial, { first: "8", potted: ["8"] }),
      state: initial,
    });
    expect(eight.state.pendingDecision).toMatchObject({
      chooserSeatId: seat1,
      choices: ["spot-eight", "rerack-self"],
      reason: "eight-on-break",
    });

    const spotted = handleBilliardsAction(
      createTestActionContextV1({ actor: { kind: "human", seatId: seat1 } }),
      eight.state,
      { choice: "spot-eight", type: "billiards.break-choice" },
    );
    expect(spotted.state).toMatchObject({
      activeSeatId: seat1,
      ballInHandZone: null,
      breakShot: false,
      phase: "aiming",
    });
    expect(spotted.state.balls.find(({ kind }) => kind === "eight")?.pocketed).toBe(false);

    const reracked = handleBilliardsAction(
      createTestActionContextV1({ actor: { kind: "human", seatId: seat1 } }),
      eight.state,
      { choice: "rerack-self", type: "billiards.break-choice" },
    );
    expect(reracked.state).toMatchObject({
      activeSeatId: seat1,
      ballInHandZone: "behind-line",
      breakShot: true,
      phase: "ball_in_hand",
      shotNumber: 1,
    });
  });

  it("offers spot plus line-in-hand or either rerack after a foul eight on the break", () => {
    const initial = readyToShoot(state("chinese-eight-ball"));
    const foulEight = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(initial, { first: "8", potted: ["8", "cue"] }),
      state: initial,
    });
    expect(foulEight.state.pendingDecision).toMatchObject({
      chooserSeatId: seat2,
      choices: ["spot-eight", "rerack-self", "rerack-opponent"],
      reason: "eight-on-break-foul",
    });

    const spotted = handleBilliardsAction(
      createTestActionContextV1({ actor: { kind: "human", seatId: seat2 } }),
      foulEight.state,
      { choice: "spot-eight", type: "billiards.break-choice" },
    );
    expect(spotted.state).toMatchObject({
      activeSeatId: seat2,
      ballInHandZone: "behind-line",
      phase: "ball_in_hand",
    });
    expect(spotted.state.balls.find(({ kind }) => kind === "eight")?.pocketed).toBe(false);

    for (const [choice, breaker] of [
      ["rerack-self", seat2],
      ["rerack-opponent", seat1],
    ] as const) {
      const reracked = handleBilliardsAction(
        createTestActionContextV1({ actor: { kind: "human", seatId: seat2 } }),
        foulEight.state,
        { choice, type: "billiards.break-choice" },
      );
      expect(reracked.state.activeSeatId).toBe(breaker);
      expect(reracked.state.ballInHandZone).toBe("behind-line");
    }
  });

  it("assigns groups from first contacts and pauses for a simultaneous two-group choice", () => {
    const open: BilliardsMatchState = {
      ...readyToShoot(state("chinese-eight-ball")),
      breakShot: false,
    };
    const assigned = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(open, { first: "1", potted: ["1"] }),
      state: open,
    });

    expect(assigned.foulCode).toBeNull();
    expect(assigned.state.players).toMatchObject([
      { group: "solids", score: 1, seatId: seat1 },
      { group: "stripes", seatId: seat2 },
    ]);
    expect(assigned.state.activeSeatId).toBe(seat1);

    const simultaneous = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(open, {
        firsts: ["1", "9"],
        potted: ["1", "9"],
      }),
      state: open,
    });
    expect(simultaneous.state).toMatchObject({
      activeSeatId: seat1,
      pendingDecision: {
        chooserSeatId: seat1,
        groups: ["solids", "stripes"],
        type: "choose-group",
      },
      phase: "decision",
    });
    const groupView = projectBilliardsView(createTestProjectionContextV1(), simultaneous.state, {
      kind: "player",
      seatId: seat1,
    });
    expect(groupView.legalActions).toMatchObject({
      canChooseGroup: true,
      canResolveBreak: false,
      canShoot: false,
    });
    expectRuleCode(
      () =>
        handleBilliardsAction(
          createTestActionContextV1({ actor: { kind: "human", seatId: seat2 } }),
          simultaneous.state,
          { group: "solids", type: "billiards.choose-group" },
        ),
      "NOT_YOUR_TURN",
    );
    const chosen = handleBilliardsAction(
      createTestActionContextV1({ actor: { kind: "human", seatId: seat1 } }),
      simultaneous.state,
      { group: "stripes", type: "billiards.choose-group" },
    );
    expect(chosen.state.players).toMatchObject([
      { group: "stripes", score: 1, seatId: seat1 },
      { group: "solids", score: 1, seatId: seat2 },
    ]);
    expect(chosen.state).toMatchObject({ activeSeatId: seat1, phase: "aiming" });

    const onePotted = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(open, { firsts: ["1", "9"], potted: ["9"] }),
      state: open,
    });
    expect(onePotted.state.players.find(({ seatId }) => seatId === seat1)?.group).toBe("stripes");

    const oppositeOnly = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(open, { first: "1", potted: ["9"] }),
      state: open,
    });
    expect(oppositeOnly.state.players.every(({ group }) => group === "open")).toBe(true);
    expect(oppositeOnly.state.activeSeatId).toBe(seat2);
  });

  it("leaves opponent balls down without a foul and continues only after an own-group pot", () => {
    const assigned = withEightBallGroups(state("chinese-eight-ball"));
    const opponentOnly = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(assigned, { first: "1", potted: ["9"] }),
      state: assigned,
    });
    expect(opponentOnly.foulCode).toBeNull();
    expect(opponentOnly.state.balls.find(({ id }) => id === "9")?.pocketed).toBe(true);
    expect(opponentOnly.state.activeSeatId).toBe(seat2);

    const both = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(assigned, { first: "1", potted: ["1", "9"] }),
      state: assigned,
    });
    expect(both.foulCode).toBeNull();
    expect(both.state.activeSeatId).toBe(seat1);
  });

  it("accepts a near-simultaneous first contact when at least one contacted ball is legal", () => {
    const assigned = withEightBallGroups(state("chinese-eight-ball"));
    const result = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(assigned, {
        firsts: ["1", "9"],
        postContactRails: ["1"],
      }),
      state: assigned,
    });
    expect(result.foulCode).toBeNull();
    expect(result.state.activeSeatId).toBe(seat2);
  });

  it("only treats an actual lower-hemisphere jump as an illegal Heyball jump", () => {
    const assigned = withEightBallGroups(state("chinese-eight-ball"));
    const lowerTip: BilliardsShot = { ...shot(), tip: { x: 0, y: -0.4 } };
    const illegal = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: lowerTip,
      simulation: simulation(assigned, {
        first: "1",
        jumped: ["9"],
        postContactRails: ["1"],
      }),
      state: assigned,
    });
    expect(illegal.foulCode).toBe("ILLEGAL_JUMP");

    const upperTip: BilliardsShot = { ...shot(), tip: { x: 0, y: 0.4 } };
    const legal = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: upperTip,
      simulation: simulation(assigned, {
        first: "1",
        jumped: ["9"],
        postContactRails: ["1"],
      }),
      state: assigned,
    });
    expect(legal.foulCode).toBeNull();
  });

  it("grants ordinary fouls anywhere in hand and requires a post-contact rail", () => {
    const assigned = withEightBallGroups(state("chinese-eight-ball"));

    const foul = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(assigned, { first: "9", postContactRails: ["9"] }),
      state: assigned,
    });
    expect(foul.foulCode).toBe("WRONG_FIRST_CONTACT");
    expect(foul.state).toMatchObject({
      activeSeatId: seat2,
      ballInHandZone: "anywhere",
      phase: "ball_in_hand",
    });
    expect(foul.state.balls.find(({ kind }) => kind === "cue")?.pocketed).toBe(true);

    const noRail = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(assigned, {
        first: "1",
        postContactRails: [],
        rails: ["cue"],
      }),
      state: assigned,
    });
    expect(noRail.foulCode).toBe("NO_RAIL_OR_POCKET");
  });

  it("wins on a clean eight after clearance and loses on an early or foul eight", () => {
    const cleared = withEightBallGroups(state("chinese-eight-ball"), { clearSolids: true });
    const won = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(cleared, { first: "8", potted: ["8"] }),
      state: cleared,
    });
    expect(won.state.outcome).toEqual({ reason: "eight-ball", winnerSeatId: seat1 });

    const uncleared = withEightBallGroups(state("chinese-eight-ball"));
    const early = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(uncleared, { first: "8", potted: ["8"] }),
      state: uncleared,
    });
    expect(early.foulCode).toBe("EIGHT_BALL_POTTED_EARLY");
    expect(early.state.outcome?.winnerSeatId).toBe(seat2);

    const scratch = adjudicateChineseEightBallShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(cleared, { first: "8", potted: ["8", "cue"] }),
      state: cleared,
    });
    expect(scratch.foulCode).toBe("EIGHT_BALL_POTTED_ON_FOUL");
    expect(scratch.state.outcome?.winnerSeatId).toBe(seat2);
  });
});

describe("snooker rules", () => {
  it("scores red then nominated color and respots the color", () => {
    const initial = readyToShoot(state("snooker"));
    const red = adjudicateSnookerShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(initial, { first: "red-1", potted: ["red-1"] }),
      state: initial,
    });
    expect(red).toMatchObject({ points: 1, state: { activeSeatId: seat1, snookerOn: "color" } });

    const black = adjudicateSnookerShot({
      actorSeatId: seat1,
      shot: shot("black"),
      simulation: simulation(red.state, { first: "black", potted: ["black"] }),
      state: red.state,
    });
    const blackSpot = tableSpecFor("snooker").spots.find(({ id }) => id === "black");
    const blackBall = black.state.balls.find(({ kind }) => kind === "black");
    expect(black).toMatchObject({ points: 7, state: { activeSeatId: seat1, snookerOn: "red" } });
    expect(black.state.players.find(({ seatId }) => seatId === seat1)?.score).toBe(8);
    expect(blackBall?.pocketed).toBe(false);
    expect(blackBall?.x).toBeCloseTo(blackSpot?.x ?? 0);
  });

  it("does not respot a color on top of the cue ball", () => {
    const initial = readyToShoot(state("snooker"));
    const blackSpot = tableSpecFor("snooker").spots.find(({ id }) => id === "black");
    if (!blackSpot) throw new Error("missing black spot");
    const colorOn: BilliardsMatchState = {
      ...initial,
      balls: initial.balls.map((ball) =>
        ball.kind === "cue" ? { ...ball, x: blackSpot.x, y: blackSpot.y } : ball,
      ),
      breakShot: false,
      snookerOn: "color",
    };
    const result = adjudicateSnookerShot({
      actorSeatId: seat1,
      shot: shot("black"),
      simulation: simulation(colorOn, { first: "black", potted: ["black"] }),
      state: colorOn,
    });
    const cue = result.state.balls.find(({ kind }) => kind === "cue");
    const black = result.state.balls.find(({ kind }) => kind === "black");

    expect(cue).toBeDefined();
    expect(black).toBeDefined();
    expect(Math.hypot(black!.x - cue!.x, black!.y - cue!.y)).toBeGreaterThanOrEqual(
      tableSpecFor("snooker").ballDiameter - 1e-9,
    );
  });

  it("takes one nominated color after the final red, then starts the ordered clearance", () => {
    const initial = readyToShoot(state("snooker"));
    const lastRed: BilliardsMatchState = {
      ...initial,
      balls: initial.balls.map((ball) =>
        ball.kind === "red" && ball.id !== "red-1" ? { ...ball, pocketed: true } : ball,
      ),
      breakShot: false,
    };
    const red = adjudicateSnookerShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(lastRed, { first: "red-1", potted: ["red-1"] }),
      state: lastRed,
    });
    expect(red.state.snookerOn).toBe("color");

    const blue = adjudicateSnookerShot({
      actorSeatId: seat1,
      shot: shot("blue"),
      simulation: simulation(red.state, { first: "blue", potted: ["blue"] }),
      state: red.state,
    });
    expect(blue.state.snookerOn).toBe("yellow");
    expect(blue.state.balls.find(({ kind }) => kind === "blue")?.pocketed).toBe(false);
  });

  it("awards at least four foul points, using the highest involved color", () => {
    const initial = readyToShoot(state("snooker"));
    const foul = adjudicateSnookerShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(initial, { first: "black", potted: ["black"] }),
      state: initial,
    });
    expect(foul.foulCode).toBe("WRONG_FIRST_CONTACT");
    expect(foul.points).toBe(7);
    expect(foul.state.players.find(({ seatId }) => seatId === seat2)?.score).toBe(7);
    expect(foul.state.balls.find(({ kind }) => kind === "black")?.pocketed).toBe(false);
    expect(foul.state.activeSeatId).toBe(seat2);

    const scratch = adjudicateSnookerShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(initial, { first: "red-1", potted: ["cue"] }),
      state: initial,
    });
    expect(scratch).toMatchObject({
      foulCode: "CUE_BALL_POTTED",
      points: 4,
      state: { activeSeatId: seat2, ballInHandZone: "d", phase: "ball_in_hand" },
    });
  });

  it("treats every snooker jump as a foul and uses the highest jumped ball value", () => {
    const initial = readyToShoot(state("snooker"));
    const jump = adjudicateSnookerShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(initial, {
        first: "red-1",
        jumped: ["black"],
      }),
      state: initial,
    });
    expect(jump).toMatchObject({
      foulCode: "JUMP_SHOT",
      points: 7,
      state: { activeSeatId: seat2 },
    });

    const simultaneous = adjudicateSnookerShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(initial, { firsts: ["red-1", "black"] }),
      state: initial,
    });
    expect(simultaneous.foulCode).toBe("WRONG_FIRST_CONTACT");
    expect(simultaneous.points).toBe(7);
  });

  it("keeps legal clearance colors down and advances yellow through black", () => {
    const initial = readyToShoot(state("snooker"));
    const clearance: BilliardsMatchState = {
      ...initial,
      balls: initial.balls.map((ball) =>
        ball.kind === "red" ? { ...ball, pocketed: true } : ball,
      ),
      breakShot: false,
      snookerOn: "yellow",
    };
    const yellow = adjudicateSnookerShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(clearance, { first: "yellow", potted: ["yellow"] }),
      state: clearance,
    });
    expect(yellow).toMatchObject({ points: 2, state: { activeSeatId: seat1, snookerOn: "green" } });
    expect(yellow.state.balls.find(({ kind }) => kind === "yellow")?.pocketed).toBe(true);
  });

  it("respots a tied final black for a D in-hand decider, then declares the winner", () => {
    const initial = withSnookerScores(readyToShoot(state("snooker")), 43, 50);
    const finalBlack: BilliardsMatchState = {
      ...initial,
      balls: initial.balls.map((ball) =>
        ball.kind === "red" ||
        ball.kind === "yellow" ||
        ball.kind === "green" ||
        ball.kind === "brown" ||
        ball.kind === "blue" ||
        ball.kind === "pink"
          ? { ...ball, pocketed: true }
          : ball,
      ),
      breakShot: false,
      snookerOn: "black",
    };
    const tied = adjudicateSnookerShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(finalBlack, { first: "black", potted: ["black"] }),
      state: finalBlack,
    });
    expect(tied.state).toMatchObject({
      activeSeatId: seat2,
      ballInHandZone: null,
      decidingBlack: true,
      outcome: null,
      pendingDecision: {
        chooserSeatId: seat2,
        choices: ["play-self", "defer"],
        type: "deciding-black-choice",
      },
      phase: "decision",
      snookerOn: "black",
    });
    expect(tied.state.balls.find(({ kind }) => kind === "black")?.pocketed).toBe(false);

    const choseToPlay = handleBilliardsAction(
      createTestActionContextV1({ actor: { kind: "human", seatId: seat2 } }),
      tied.state,
      { choice: "play-self", type: "billiards.deciding-black-choice" },
    );
    expect(choseToPlay.state).toMatchObject({
      activeSeatId: seat2,
      ballInHandZone: "d",
      pendingDecision: null,
      phase: "ball_in_hand",
    });

    const deciding: BilliardsMatchState = {
      ...choseToPlay.state,
      ballInHandZone: null,
      balls: choseToPlay.state.balls.map((ball) =>
        ball.kind === "cue" ? { ...ball, pocketed: false } : ball,
      ),
      phase: "aiming",
    };
    const won = adjudicateSnookerShot({
      actorSeatId: seat2,
      shot: shot(),
      simulation: simulation(deciding, { first: "black", potted: ["black"] }),
      state: deciding,
    });
    expect(won.state.outcome).toEqual({ reason: "final-black", winnerSeatId: seat2 });
  });

  it("marks a cue resting on the black spot in hand before respotting a tied final black", () => {
    const initial = withSnookerScores(readyToShoot(state("snooker")), 43, 50);
    const blackSpot = tableSpecFor("snooker").spots.find(({ id }) => id === "black");
    if (!blackSpot) throw new Error("missing black spot");
    const finalBlack: BilliardsMatchState = {
      ...initial,
      balls: initial.balls.map((ball) =>
        ball.kind === "red" ||
        ball.kind === "yellow" ||
        ball.kind === "green" ||
        ball.kind === "brown" ||
        ball.kind === "blue" ||
        ball.kind === "pink"
          ? { ...ball, pocketed: true }
          : ball,
      ),
      breakShot: false,
      snookerOn: "black",
    };
    const baseSimulation = simulation(finalBlack, { first: "black", potted: ["black"] });
    const tied = adjudicateSnookerShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: {
        ...baseSimulation,
        balls: baseSimulation.balls.map((ball) =>
          ball.kind === "cue" ? { ...ball, pocketed: false, x: blackSpot.x, y: blackSpot.y } : ball,
        ),
      },
      state: finalBlack,
    });
    const cue = tied.state.balls.find(({ kind }) => kind === "cue");
    const black = tied.state.balls.find(({ kind }) => kind === "black");
    expect(tied.state).toMatchObject({ ballInHandZone: null, phase: "decision" });
    expect(cue?.pocketed).toBe(true);
    expect(black).toMatchObject({ pocketed: false, x: blackSpot.x, y: blackSpot.y });
  });

  it("lets the deciding-black toss winner defer the first shot", () => {
    const initial = withSnookerScores(readyToShoot(state("snooker")), 43, 50);
    const finalBlack: BilliardsMatchState = {
      ...initial,
      balls: initial.balls.map((ball) =>
        ball.kind === "red" ||
        ball.kind === "yellow" ||
        ball.kind === "green" ||
        ball.kind === "brown" ||
        ball.kind === "blue" ||
        ball.kind === "pink"
          ? { ...ball, pocketed: true }
          : ball,
      ),
      breakShot: false,
      snookerOn: "black",
    };
    const tied = adjudicateSnookerShot(
      {
        actorSeatId: seat1,
        shot: shot(),
        simulation: simulation(finalBlack, { first: "black", potted: ["black"] }),
        state: finalBlack,
      },
      0,
    );
    expect(tied.state.pendingDecision).toMatchObject({ chooserSeatId: seat1 });

    const deferred = handleBilliardsAction(
      createTestActionContextV1({ actor: { kind: "human", seatId: seat1 } }),
      tied.state,
      { choice: "defer", type: "billiards.deciding-black-choice" },
    );
    expect(deferred.state).toMatchObject({
      activeSeatId: seat2,
      ballInHandZone: "d",
      pendingDecision: null,
      phase: "ball_in_hand",
    });
  });
});

describe("single-player practice", () => {
  it("accepts one human plus one empty lobby seat and creates a one-seat practice state", () => {
    const definitions = billiardsServerModule.lobby?.getSeatDefinitions({
      ...settings("chinese-eight-ball"),
    });
    const validateStart = billiardsServerModule.lobby?.validateStart;
    if (!definitions || !validateStart) throw new Error("missing billiards lobby contract");

    expect(
      validateStart(
        {
          seats: definitions.map(({ seatId }, index) => ({
            occupant: index === 0 ? ("human" as const) : ("empty" as const),
            ready: index === 0,
            seatId,
          })),
        },
        settings("chinese-eight-ball"),
      ),
    ).toEqual({ ok: true });
    expect(
      validateStart(
        {
          seats: definitions.map(({ seatId }) => ({
            occupant: "human" as const,
            ready: true,
            seatId,
          })),
        },
        settings("chinese-eight-ball"),
      ),
    ).toEqual({ ok: true });
    expect(
      validateStart(
        {
          seats: definitions.map(({ seatId }, index) => ({
            occupant: index === 0 ? ("human" as const) : ("bot" as const),
            ready: true,
            seatId,
          })),
        },
        settings("chinese-eight-ball"),
      ),
    ).toMatchObject({ ok: false });

    const practice = createBilliardsMatch(
      createTestCreateMatchContextV1({
        seats: [{ controller: { kind: "human" }, seatId: seat1 }],
      }),
      settings("chinese-eight-ball"),
    );
    expect(practice).toMatchObject({
      activeSeatId: seat1,
      ballInHandZone: "behind-line",
      phase: "ball_in_hand",
      players: [{ group: null, score: 0, seatId: seat1 }],
      practice: true,
      seatIds: [seat1],
      snookerOn: null,
    });

    const versus = createBilliardsMatch(
      createTestCreateMatchContextV1(),
      settings("chinese-eight-ball"),
    );
    expect(versus).toMatchObject({ practice: false, seatIds: [seat1, seat2] });
  });

  it("keeps every shot with the same player and ignores competitive foul conditions", () => {
    const initial = readyToShoot(practiceState("chinese-eight-ball"));
    const result = adjudicatePracticeShot({
      actorSeatId: seat1,
      shot: { ...shot(), tip: { x: 0, y: -0.5 } },
      simulation: simulation(initial, {
        first: null,
        jumped: ["1"],
        potted: ["8"],
        postContactRails: [],
      }),
      state: initial,
    });

    expect(result).toMatchObject({
      foulCode: null,
      points: 0,
      state: {
        activeSeatId: seat1,
        ballInHandZone: null,
        lastShot: { foulCode: null, points: 0, pottedBallIds: ["8"], seatId: seat1 },
        outcome: null,
        pendingDecision: null,
        phase: "aiming",
        players: [{ group: null, score: 0, seatId: seat1 }],
        shotNumber: 1,
      },
    });
    expect(result.state.balls.find(({ kind }) => kind === "eight")?.pocketed).toBe(true);
  });

  it("keeps object balls down and grants an anywhere cue ball after a scratch", () => {
    const initial = readyToShoot(practiceState("chinese-eight-ball"));
    const result = adjudicatePracticeShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(initial, { first: "1", potted: ["1", "cue"] }),
      state: initial,
    });

    expect(result).toMatchObject({
      foulCode: null,
      points: 0,
      state: {
        activeSeatId: seat1,
        ballInHandZone: "anywhere",
        phase: "ball_in_hand",
        players: [{ score: 0 }],
      },
    });
    expect(result.state.balls.find(({ id }) => id === "1")?.pocketed).toBe(true);
    expect(result.state.balls.find(({ kind }) => kind === "cue")?.pocketed).toBe(true);
  });

  it("does not respot snooker colors or rerack a cleared practice table", () => {
    const snooker = readyToShoot(practiceState("snooker"));
    const black = adjudicatePracticeShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(snooker, { first: "black", potted: ["black"] }),
      state: snooker,
    });
    expect(black.state).toMatchObject({ activeSeatId: seat1, outcome: null, snookerOn: null });
    expect(black.state.balls.find(({ kind }) => kind === "black")?.pocketed).toBe(true);

    const eightBall = readyToShoot(practiceState("chinese-eight-ball"));
    const objectIds = eightBall.balls.filter(({ kind }) => kind !== "cue").map(({ id }) => id);
    const cleared = adjudicatePracticeShot({
      actorSeatId: seat1,
      shot: shot(),
      simulation: simulation(eightBall, { first: "1", potted: objectIds }),
      state: eightBall,
    });
    expect(cleared.state).toMatchObject({
      activeSeatId: seat1,
      breakShot: false,
      outcome: null,
      phase: "aiming",
      shotNumber: 1,
    });
    expect(
      cleared.state.balls.filter(({ kind }) => kind !== "cue").every(({ pocketed }) => pocketed),
    ).toBe(true);
  });

  it("bypasses snooker nomination, disables resignation, and projects a valid solo view", () => {
    const initial: BilliardsMatchState = {
      ...readyToShoot(practiceState("snooker")),
      snookerOn: "color",
    };
    const transition = handleBilliardsAction(
      createTestActionContextV1({ actor: { kind: "human", seatId: seat1 } }),
      initial,
      { type: "billiards.shoot", shot: shot(null) },
    );
    expect(transition).toMatchObject({
      kind: "applied",
      state: { activeSeatId: seat1, outcome: null, practice: true },
    });
    expect(transition.events[0]).toMatchObject({
      foulCode: null,
      nextSeatId: seat1,
      points: 0,
      seatId: seat1,
      type: "billiards.shot",
    });

    expectRuleCode(
      () =>
        handleBilliardsAction(
          createTestActionContextV1({ actor: { kind: "human", seatId: seat1 } }),
          initial,
          { type: "billiards.resign" },
        ),
      "RESIGN_NOT_AVAILABLE_IN_PRACTICE",
    );
    const view = projectBilliardsView(createTestProjectionContextV1(), initial, {
      kind: "player",
      seatId: seat1,
    });
    expect(view).toMatchObject({
      legalActions: { canResign: false, canShoot: true },
      players: [{ active: true, group: null, score: 0, seatId: seat1 }],
      practice: true,
      viewerSeatId: seat1,
    });
    expect(() => billiardsViewSchema.parse(view)).not.toThrow();
  });

  it("lets a solo leave close the room and releases a stale seat after disconnect grace", () => {
    const initial = practiceState("chinese-eight-ball");
    const left = handleBilliardsSystemEvent(createTestSystemEventContextV1(), initial, {
      type: "member.left",
      seatId: seat1,
    });
    expect(left).toEqual({ kind: "noop", state: initial });

    const expired = handleBilliardsSystemEvent(createTestSystemEventContextV1(), initial, {
      type: "connection.grace_expired",
      seatId: seat1,
    });
    expect(expired).toEqual({
      events: [],
      kind: "applied",
      roomDirectives: [{ seatId: seat1, type: "seat.release" }],
      state: initial,
    });
  });
});

describe("authoritative action permissions", () => {
  it("rejects a non-current player and only projects legal actions to the current human", () => {
    const initial = state("chinese-eight-ball");
    expectRuleCode(
      () =>
        handleBilliardsAction(
          createTestActionContextV1({ actor: { kind: "human", seatId: seat2 } }),
          initial,
          { type: "billiards.shoot", shot: shot() },
        ),
      "NOT_YOUR_TURN",
    );

    const waitingResign = handleBilliardsAction(
      createTestActionContextV1({ actor: { kind: "human", seatId: seat2 } }),
      initial,
      { type: "billiards.resign" },
    );
    expect(waitingResign).toMatchObject({
      kind: "applied",
      state: { outcome: { reason: "resigned", winnerSeatId: seat1 }, phase: "ended" },
    });

    const current = projectBilliardsView(createTestProjectionContextV1(), initial, {
      kind: "player",
      seatId: seat1,
    });
    const waiting = projectBilliardsView(createTestProjectionContextV1(), initial, {
      kind: "player",
      seatId: seat2,
    });
    const spectator = projectBilliardsView(createTestProjectionContextV1(), initial, {
      kind: "spectator",
    });
    expect(current.legalActions).toEqual({
      canChooseDecidingBlack: false,
      canChooseGroup: false,
      canPlaceCue: true,
      canResign: true,
      canResolveBreak: false,
      canShoot: false,
    });
    expect(waiting.legalActions).toEqual({
      canChooseDecidingBlack: false,
      canChooseGroup: false,
      canPlaceCue: false,
      canResign: true,
      canResolveBreak: false,
      canShoot: false,
    });
    expect(spectator.legalActions).toEqual({
      canChooseDecidingBlack: false,
      canChooseGroup: false,
      canPlaceCue: false,
      canResign: false,
      canResolveBreak: false,
      canShoot: false,
    });
    expect(() => billiardsViewSchema.parse(current)).not.toThrow();
  });

  it("emits a schema-valid shot event containing initial balls but no trajectory", () => {
    const initial = readyToShoot(
      createInitialBilliardsState(settings("chinese-eight-ball"), seats),
    );
    const transition = handleBilliardsAction(
      createTestActionContextV1({ actor: { kind: "human", seatId: seat1 } }),
      initial,
      { type: "billiards.shoot", shot: shot() },
    );
    if (transition.kind !== "applied") throw new Error("expected applied shot");
    const event = transition.events.find(({ type }) => type === "billiards.shot");
    if (!event || event.type !== "billiards.shot") throw new Error("expected billiards shot event");
    expect(() => billiardsDisplayEventSchema.parse(event)).not.toThrow();
    const legacyEvent: {
      physicsVersion?: string | null;
      simulationStateHash?: string | null;
      spinConvergence: number;
      tableFriction: number;
      type: "billiards.shot";
    } = {
      ...event,
      spinConvergence: 1.7,
      tableFriction: 0.26,
    };
    delete legacyEvent.physicsVersion;
    delete legacyEvent.simulationStateHash;
    const parsedLegacyEvent = billiardsDisplayEventSchema.parse(legacyEvent);
    if (parsedLegacyEvent.type !== "billiards.shot") throw new Error("expected legacy shot event");
    expect(parsedLegacyEvent.physicsVersion).toBeNull();
    expect(parsedLegacyEvent.simulationStateHash).toBeNull();
    expect(parsedLegacyEvent).not.toHaveProperty("spinConvergence");
    expect(parsedLegacyEvent).not.toHaveProperty("tableFriction");
    expect(event).toHaveProperty("initialBalls");
    expect(event.physicsVersion).toBe("pooltool-9a8abfe-rs-v1");
    expect(event.simulationStateHash).toMatch(/^[a-f0-9]{32}$/);
    expect(event).not.toHaveProperty("spinConvergence");
    expect(event).not.toHaveProperty("tableFriction");
    expect(event).not.toHaveProperty("frames");

    const replay = simulateBilliardsShot({
      balls: event.initialBalls,
      mode: event.mode,
      shot: event.shot,
    });
    expect(replay.checksum).toBe(event.simulationChecksum);
    expect(replay.physicsVersion).toBe(event.physicsVersion);
    expect(replay.stateHash).toBe(event.simulationStateHash);

    const projected = projectBilliardsView(createTestProjectionContextV1(), initial, {
      kind: "player",
      seatId: seat1,
    });
    expect(projected).not.toHaveProperty("spinConvergence");
    expect(projected).not.toHaveProperty("tableFriction");
  });

  it("ends immediately on resignation, departure, or expired disconnect grace", () => {
    const initial = state("chinese-eight-ball");
    const resigned = handleBilliardsAction(
      createTestActionContextV1({ actor: { kind: "human", seatId: seat1 } }),
      initial,
      { type: "billiards.resign" },
    );
    expect(resigned).toMatchObject({
      kind: "applied",
      outcome: { kind: "completed" },
      state: {
        outcome: { reason: "resigned", winnerSeatId: seat2 },
        phase: "ended",
      },
    });

    const left = handleBilliardsSystemEvent(createTestSystemEventContextV1(), initial, {
      type: "member.left",
      seatId: seat2,
    });
    expect(left).toMatchObject({
      kind: "applied",
      state: { outcome: { reason: "left", winnerSeatId: seat1 }, phase: "ended" },
    });

    const disconnected = handleBilliardsSystemEvent(createTestSystemEventContextV1(), initial, {
      type: "connection.grace_expired",
      seatId: seat1,
    });
    expect(disconnected).toMatchObject({
      kind: "applied",
      state: { outcome: { reason: "disconnected", winnerSeatId: seat2 }, phase: "ended" },
    });
  });
});

function expectRuleCode(run: () => unknown, expected: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GameRuleError);
    expect((error as GameRuleError).ruleCode).toBe(expected);
    return;
  }
  throw new Error(`expected GameRuleError ${expected}`);
}
