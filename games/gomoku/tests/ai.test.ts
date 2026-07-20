import {
  createTestActionContextV1,
  createTestCreateMatchContextV1,
  FakeGameClockV1,
} from "@tabletop/game-sdk/testing";
import { describe, expect, it } from "vitest";

import {
  createAutomationInput,
  gomokuBotProvider,
  type GomokuAutomationInput,
} from "../server/ai/provider.js";
import { handleGomokuAction } from "../server/engine.js";
import { BLACK, WHITE, createEmptyBoard, withStone } from "../server/rules/board.js";
import type { GomokuCell, GomokuCoordinate } from "../shared/view.js";
import { createState, seat1, seat2 } from "./helpers.js";

const PROFILE_IDS = ["easy", "normal", "hard"] as const;

describe("gomoku AI contract", () => {
  it("publishes the three documented deterministic time budgets", () => {
    expect(gomokuBotProvider.listProfiles()).toEqual([
      expect.objectContaining({ profileId: "easy", timeBudgetMs: 100 }),
      expect.objectContaining({ profileId: "normal", timeBudgetMs: 500 }),
      expect.objectContaining({ profileId: "hard", timeBudgetMs: 2_000 }),
    ]);
  });

  it.each(PROFILE_IDS)("%s takes an immediate win", async (profileId) => {
    const input = automationInput(
      boardWith(
        [
          [0, 7],
          [1, 7],
          [2, 7],
          [3, 7],
        ],
        [[7, 6]],
      ),
      [
        { x: 10, y: 10 },
        { x: 4, y: 7 },
      ],
    );

    await expect(choose(profileId, input)).resolves.toEqual({
      type: "gomoku.place",
      x: 4,
      y: 7,
    });
  });

  it.each(PROFILE_IDS)("%s blocks an opponent's immediate win", async (profileId) => {
    const input = automationInput(
      boardWith(
        [[7, 6]],
        [
          [0, 7],
          [1, 7],
          [2, 7],
          [3, 7],
        ],
      ),
      [
        { x: 10, y: 10 },
        { x: 4, y: 7 },
      ],
    );

    await expect(choose(profileId, input)).resolves.toEqual({
      type: "gomoku.place",
      x: 4,
      y: 7,
    });
  });

  it.each(PROFILE_IDS)(
    "%s returns an action accepted by the authoritative engine",
    async (profileId) => {
      const state = createState({}, { firstController: "bot" });
      const context = createTestCreateMatchContextV1();
      const input = createAutomationInput(
        { matchId: context.matchId, revision: 0, clock: new FakeGameClockV1() },
        state,
        seat1,
      );
      expect(input.legalMoves).toEqual([{ x: 7, y: 7 }]);

      const action = await choose(profileId, input);
      expect(gomokuBotProvider.inputSchema.safeParse(input).success).toBe(true);

      const transition = handleGomokuAction(
        createTestActionContextV1({
          actor: { kind: "bot", seatId: seat1, profileId },
        }),
        state,
        action,
      );
      if (transition.kind !== "applied") throw new Error("expected legal AI action");
      expect(transition.state.moves).toEqual([
        expect.objectContaining({ x: 7, y: 7, seatId: seat1, color: "black" }),
      ]);
    },
  );

  it("only exposes legal moves to the active seat", () => {
    const state = createState();
    const context = createTestCreateMatchContextV1();
    const automationContext = {
      matchId: context.matchId,
      revision: 0,
      clock: new FakeGameClockV1(),
    };

    expect(createAutomationInput(automationContext, state, seat1).legalMoves).toEqual([
      { x: 7, y: 7 },
    ]);
    expect(createAutomationInput(automationContext, state, seat2).legalMoves).toEqual([]);
  });
});

function choose(profileId: (typeof PROFILE_IDS)[number], input: GomokuAutomationInput) {
  const profile = gomokuBotProvider
    .listProfiles()
    .find((candidate) => candidate.profileId === profileId);
  if (profile === undefined) throw new Error(`missing profile ${profileId}`);
  return gomokuBotProvider.chooseAction({
    seatId: seat1,
    input,
    revision: 0,
    hardDeadlineMonotonicMs: profile.timeBudgetMs,
    decisionSeed: `test-${profileId}`,
    profileId,
  });
}

function automationInput(
  board: readonly GomokuCell[],
  legalMoves: readonly GomokuCoordinate[],
): GomokuAutomationInput {
  return {
    board: [...board],
    rule: "freestyle",
    color: "black",
    legalMoves: legalMoves.map((move) => ({ ...move })),
  };
}

function boardWith(
  black: readonly (readonly [number, number])[],
  white: readonly (readonly [number, number])[],
): GomokuCell[] {
  let board = createEmptyBoard();
  for (const [x, y] of black) board = withStone(board, x, y, BLACK);
  for (const [x, y] of white) board = withStone(board, x, y, WHITE);
  return board;
}
