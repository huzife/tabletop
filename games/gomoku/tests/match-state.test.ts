import { GameRuleError } from "@tabletop/game-sdk/server";
import { createTestCreateMatchContextV1, SequenceGameRandomV1 } from "@tabletop/game-sdk/testing";
import { describe, expect, it } from "vitest";

import { createGomokuMatch, handleGomokuAction } from "../server/engine.js";
import { boardIndex } from "../server/rules/board.js";
import { actionContext, appliedState, defaultSettings, seat1, seat2 } from "./helpers.js";

describe("gomoku match state", () => {
  it("uses secure randomness for the first black seat and swaps colors for a rematch", () => {
    const firstRandom = new SequenceGameRandomV1([{ label: "gomoku.first-black-seat", value: 1 }]);
    const firstContext = createTestCreateMatchContextV1({ random: firstRandom });
    const first = createGomokuMatch(firstContext, defaultSettings);

    expect(first.seatByColor).toEqual({ black: seat2, white: seat1 });
    firstRandom.assertExhausted();

    const resigned = handleGomokuAction(actionContext(seat1), first, { type: "gomoku.resign" });
    if (resigned.kind !== "applied" || resigned.outcome === undefined) {
      throw new Error("expected a completed first match");
    }
    const publicSummary = resigned.outcome.publicSummary;
    if (publicSummary === undefined) throw new Error("expected a public match summary");

    const rematchRandom = new SequenceGameRandomV1([]);
    const rematch = createGomokuMatch(
      createTestCreateMatchContextV1({
        previousSummary: {
          matchId: firstContext.matchId,
          publicSummary,
        },
        random: rematchRandom,
      }),
      defaultSettings,
    );

    expect(rematch.seatByColor).toEqual({ black: seat1, white: seat2 });
    rematchRandom.assertExhausted();
  });

  it("rejects a non-current player and an occupied point without mutating the position", () => {
    const initial = createGomokuMatch(
      createTestCreateMatchContextV1({ random: new SequenceGameRandomV1([0]) }),
      defaultSettings,
    );

    expectRuleCode(
      () =>
        handleGomokuAction(actionContext(seat2), initial, {
          type: "gomoku.place",
          x: 7,
          y: 7,
        }),
      "NOT_YOUR_TURN",
    );
    expect(initial.moves).toHaveLength(0);

    const afterBlack = appliedState(
      handleGomokuAction(actionContext(seat1), initial, {
        type: "gomoku.place",
        x: 7,
        y: 7,
      }),
    );
    const boardBeforeRejectedMove = afterBlack.board;

    expectRuleCode(
      () =>
        handleGomokuAction(actionContext(seat2), afterBlack, {
          type: "gomoku.place",
          x: 7,
          y: 7,
        }),
      "POSITION_OCCUPIED",
    );
    expect(afterBlack.board).toBe(boardBeforeRejectedMove);
    expect(afterBlack.board[boardIndex(7, 7)]).toBe(1);
    expect(afterBlack.moves).toHaveLength(1);
    expect(afterBlack.turn).toBe("white");
  });

  it("ends immediately when a player resigns", () => {
    const state = createGomokuMatch(
      createTestCreateMatchContextV1({ random: new SequenceGameRandomV1([0]) }),
      defaultSettings,
    );
    const transition = handleGomokuAction(actionContext(seat1), state, { type: "gomoku.resign" });

    if (transition.kind !== "applied") throw new Error("expected resignation to apply");
    expect(transition.state).toMatchObject({
      phase: "ended",
      winnerSeatId: seat2,
      endReason: "resigned",
    });
    expect(transition.events).toContainEqual({
      type: "gomoku.matchEnded",
      winnerSeatId: seat2,
      reason: "resigned",
    });
    expect(transition.outcome?.publicSummary).toMatchObject({
      seatByColor: { black: seat1, white: seat2 },
      winnerSeatId: seat2,
      endReason: "resigned",
    });
  });
});

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
