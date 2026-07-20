import { GameRuleError } from "@tabletop/game-sdk/server";
import { describe, expect, it } from "vitest";

import {
  getGomokuActiveSeatIds,
  getGomokuDeadlines,
  handleGomokuAction,
  handleGomokuDeadline,
  projectGomokuView,
} from "../server/engine.js";
import { boardIndex } from "../server/rules/board.js";
import type { GomokuMatchState } from "../server/state.js";
import {
  actionContext,
  appliedState,
  createState,
  deadlineContext,
  projectionContext,
  seat1,
  seat2,
} from "./helpers.js";

describe("gomoku clocks", () => {
  it.each([
    {
      name: "per-move clock",
      settings: { totalTimeMinutes: 60, moveTimeSeconds: 5 },
      expiresAt: 5_000,
    },
    {
      name: "total clock",
      settings: { totalTimeMinutes: 1, moveTimeSeconds: 300 },
      expiresAt: 60_000,
    },
  ])(
    "accepts just before and times out exactly at the $name boundary",
    ({ settings, expiresAt }) => {
      const justBefore = createState({ timerEnabled: true, ...settings });
      const accepted = appliedState(
        handleGomokuAction(actionContext(seat1, expiresAt - 1), justBefore, {
          type: "gomoku.place",
          x: 7,
          y: 7,
        }),
      );
      expect(accepted.moves).toHaveLength(1);
      expect(accepted.phase).toBe("playing");

      const atBoundary = createState({ timerEnabled: true, ...settings });
      const timedOut = appliedState(
        handleGomokuAction(actionContext(seat1, expiresAt), atBoundary, {
          type: "gomoku.place",
          x: 7,
          y: 7,
        }),
      );
      expect(timedOut).toMatchObject({
        phase: "ended",
        endReason: "timeout",
        winnerSeatId: seat2,
      });
      expect(timedOut.moves).toHaveLength(0);
      expect(timedOut.board[boardIndex(7, 7)]).toBe(0);
    },
  );

  it.each([
    {
      name: "per-move clock",
      settings: { totalTimeMinutes: 60, moveTimeSeconds: 5 },
      dueAt: 5_000,
    },
    {
      name: "total clock",
      settings: { totalTimeMinutes: 1, moveTimeSeconds: 300 },
      dueAt: 60_000,
    },
  ])("schedules and enforces the $name deadline at the exact due time", ({ settings, dueAt }) => {
    const state = createState({ timerEnabled: true, ...settings });
    const deadline = onlyDeadline(state);
    expect(deadline.dueAtMonotonicMs).toBe(dueAt);

    expect(handleGomokuDeadline(deadlineContext(dueAt - 1), state, deadline)).toEqual({
      kind: "noop",
      state,
    });

    const transition = handleGomokuDeadline(deadlineContext(dueAt), state, deadline);
    if (transition.kind !== "applied") throw new Error("expected timeout transition");
    expect(transition.state).toMatchObject({
      phase: "ended",
      endReason: "timeout",
      winnerSeatId: seat2,
    });
  });
});

describe("gomoku undo offers", () => {
  it("only lets the actor of the latest move request an undo before the opponent moves", () => {
    const initial = createState();
    expectRuleCode(
      () =>
        handleGomokuAction(actionContext(seat2), initial, {
          type: "gomoku.undo.request",
        }),
      "UNDO_NOT_AVAILABLE",
    );

    const afterBlack = place(initial, seat1, 7, 7);
    expectRuleCode(
      () =>
        handleGomokuAction(actionContext(seat2), afterBlack, {
          type: "gomoku.undo.request",
        }),
      "UNDO_NOT_AVAILABLE",
    );

    const afterWhite = place(afterBlack, seat2, 7, 8);
    expectRuleCode(
      () =>
        handleGomokuAction(actionContext(seat1), afterWhite, {
          type: "gomoku.undo.request",
        }),
      "UNDO_NOT_AVAILABLE",
    );
  });

  it("settles the responder clock, pauses it, and resumes the frozen remainder after rejection", () => {
    const afterBlack = place(
      createState({ timerEnabled: true, totalTimeMinutes: 1, moveTimeSeconds: 5 }),
      seat1,
      7,
      7,
      1_000,
    );
    const requested = appliedState(
      handleGomokuAction(actionContext(seat1, 3_000), afterBlack, {
        type: "gomoku.undo.request",
      }),
    );

    expect(requested.phase).toBe("undo_pending");
    expect(requested.pendingOffer).toMatchObject({
      kind: "undo",
      requesterSeatId: seat1,
      responderSeatId: seat2,
      expiresAtMonotonicMs: 33_000,
    });
    expectClock(requested, {
      turnStartedAtMonotonicMs: null,
      stepRemainingAtStartMs: 3_000,
      remainingTotalMs: { [seat1]: 59_000, [seat2]: 58_000 },
    });
    expect(getGomokuDeadlines(requested)).toEqual([
      expect.objectContaining({ dueAtMonotonicMs: 33_000 }),
    ]);

    const rejected = appliedState(
      handleGomokuAction(actionContext(seat2, 10_000), requested, {
        type: "gomoku.undo.respond",
        accept: false,
      }),
    );
    expect(rejected).toMatchObject({ phase: "playing", pendingOffer: null });
    expectClock(rejected, {
      turnStartedAtMonotonicMs: 10_000,
      stepRemainingAtStartMs: 3_000,
      remainingTotalMs: { [seat1]: 59_000, [seat2]: 58_000 },
    });
    expect(onlyDeadline(rejected).dueAtMonotonicMs).toBe(13_000);

    const timedOut = appliedState(
      handleGomokuDeadline(deadlineContext(13_000), rejected, onlyDeadline(rejected)),
    );
    expect(timedOut).toMatchObject({
      phase: "ended",
      endReason: "timeout",
      winnerSeatId: seat1,
    });
  });

  it("expires after 30 seconds, resumes the clock, and forbids a second request at that position", () => {
    const afterBlack = place(
      createState({ timerEnabled: true, totalTimeMinutes: 1, moveTimeSeconds: 5 }),
      seat1,
      7,
      7,
      1_000,
    );
    const requested = appliedState(
      handleGomokuAction(actionContext(seat1, 3_000), afterBlack, {
        type: "gomoku.undo.request",
      }),
    );
    const offerDeadline = onlyDeadline(requested);

    expect(handleGomokuDeadline(deadlineContext(32_999), requested, offerDeadline)).toEqual({
      kind: "noop",
      state: requested,
    });

    const expired = handleGomokuDeadline(deadlineContext(33_000), requested, offerDeadline);
    if (expired.kind !== "applied") throw new Error("expected undo expiry transition");
    expect(expired.events).toContainEqual({
      type: "gomoku.offerResolved",
      kind: "undo",
      resolution: "expired",
    });
    expectClock(expired.state, {
      turnStartedAtMonotonicMs: 33_000,
      stepRemainingAtStartMs: 3_000,
      remainingTotalMs: { [seat1]: 59_000, [seat2]: 58_000 },
    });

    expectRuleCode(
      () =>
        handleGomokuAction(actionContext(seat1, 33_000), expired.state, {
          type: "gomoku.undo.request",
        }),
      "UNDO_NOT_AVAILABLE",
    );
  });

  it("has an AI responder accept immediately and gives the requester a fresh move step", () => {
    const afterBlack = place(
      createState(
        { timerEnabled: true, totalTimeMinutes: 1, moveTimeSeconds: 5 },
        { secondController: "bot" },
      ),
      seat1,
      7,
      7,
      1_000,
    );
    const transition = handleGomokuAction(actionContext(seat1, 3_000), afterBlack, {
      type: "gomoku.undo.request",
    });
    if (transition.kind !== "applied") throw new Error("expected automatic undo approval");

    expect(transition.state).toMatchObject({
      phase: "playing",
      turn: "black",
      pendingOffer: null,
      moves: [],
    });
    expect(transition.state.board[boardIndex(7, 7)]).toBe(0);
    expectClock(transition.state, {
      turnStartedAtMonotonicMs: 3_000,
      stepRemainingAtStartMs: 5_000,
      remainingTotalMs: { [seat1]: 59_000, [seat2]: 58_000 },
    });
    expect(transition.events).toEqual([
      { type: "gomoku.offerCreated", kind: "undo" },
      { type: "gomoku.offerResolved", kind: "undo", resolution: "accepted" },
      { type: "gomoku.stoneRemoved", x: 7, y: 7 },
    ]);
  });
});

describe("gomoku draw offers", () => {
  it("allows the non-current player to offer without pausing and cancels it on a move", () => {
    const initial = createState({ timerEnabled: true, totalTimeMinutes: 1, moveTimeSeconds: 5 });
    const offered = appliedState(
      handleGomokuAction(actionContext(seat2, 1_000), initial, {
        type: "gomoku.draw.offer",
      }),
    );

    expect(offered).toMatchObject({ phase: "playing", turn: "black" });
    expect(offered.pendingOffer).toMatchObject({
      kind: "draw",
      requesterSeatId: seat2,
      responderSeatId: seat1,
    });
    expect(getGomokuActiveSeatIds(offered)).toEqual([seat1]);
    expectClock(offered, {
      turnStartedAtMonotonicMs: 1_000,
      stepRemainingAtStartMs: 4_000,
      remainingTotalMs: { [seat1]: 59_000, [seat2]: 60_000 },
    });
    const projected = projectGomokuView(projectionContext(2_000), offered, {
      kind: "player",
      seatId: seat1,
    });
    expect(projected.moveRemainingMs).toBe(3_000);
    expect(projected.players.find(({ seatId }) => seatId === seat1)?.totalRemainingMs).toBe(58_000);

    const placed = handleGomokuAction(actionContext(seat1, 2_000), offered, {
      type: "gomoku.place",
      x: 7,
      y: 7,
    });
    if (placed.kind !== "applied") throw new Error("expected move to cancel draw offer");
    expect(placed.state.pendingOffer).toBeNull();
    expect(placed.events).toEqual([
      { type: "gomoku.offerResolved", kind: "draw", resolution: "cancelled" },
      { type: "gomoku.stonePlaced", x: 7, y: 7, color: "black" },
    ]);
  });

  it("has an AI responder reject immediately", () => {
    const state = createState({}, { secondController: "bot" });
    const transition = handleGomokuAction(actionContext(seat1), state, {
      type: "gomoku.draw.offer",
    });
    if (transition.kind !== "applied") throw new Error("expected automatic draw rejection");

    expect(transition.state.pendingOffer).toBeNull();
    expect(transition.state.phase).toBe("playing");
    expect(transition.events).toEqual([
      { type: "gomoku.offerCreated", kind: "draw" },
      { type: "gomoku.offerResolved", kind: "draw", resolution: "rejected" },
    ]);
  });
});

function place(
  state: Readonly<GomokuMatchState>,
  seatId: typeof seat1 | typeof seat2,
  x: number,
  y: number,
  now = 0,
): GomokuMatchState {
  return appliedState(
    handleGomokuAction(actionContext(seatId, now), state, {
      type: "gomoku.place",
      x,
      y,
    }),
  );
}

function onlyDeadline(state: Readonly<GomokuMatchState>) {
  const deadlines = getGomokuDeadlines(state);
  expect(deadlines).toHaveLength(1);
  const deadline = deadlines[0];
  if (deadline === undefined) throw new Error("expected one deadline");
  return deadline;
}

function expectClock(
  state: Readonly<GomokuMatchState>,
  expected: {
    readonly turnStartedAtMonotonicMs: number | null;
    readonly stepRemainingAtStartMs: number;
    readonly remainingTotalMs: Readonly<Record<string, number>>;
  },
): void {
  if (!state.clock.enabled) throw new Error("expected an enabled clock");
  expect(state.clock).toMatchObject(expected);
}

function expectRuleCode(run: () => unknown, ruleCode: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GameRuleError);
    expect((error as GameRuleError).ruleCode).toBe(ruleCode);
    return;
  }
  throw new Error(`expected GameRuleError ${ruleCode}`);
}
