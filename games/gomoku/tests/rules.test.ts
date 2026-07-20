import { describe, expect, it } from "vitest";

import type { GomokuCell, GomokuColor, GomokuCoordinate } from "../shared/view.js";
import { BLACK, WHITE, createEmptyBoard, withStone } from "../server/rules/board.js";
import { evaluatePlacement } from "../server/rules/evaluator.js";
import { analyzeRenjuBlackMove } from "../server/rules/renju.js";

describe("gomoku rule evaluator", () => {
  it.each([
    {
      stones: [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ],
      move: [4, 0],
    },
    {
      stones: [
        [14, 0],
        [14, 1],
        [14, 2],
        [14, 3],
      ],
      move: [14, 4],
    },
    {
      stones: [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      move: [4, 4],
    },
    {
      stones: [
        [14, 0],
        [13, 1],
        [12, 2],
        [11, 3],
      ],
      move: [10, 4],
    },
  ])("wins along all four axes at board boundaries", ({ stones, move }) => {
    const board = boardWith(stones, "black");
    const result = evaluatePlacement(board, "freestyle", "black", point(move));
    expect(result.legal).toBe(true);
    expect(result.won).toBe(true);
    expect(result.winningCells).toHaveLength(5);
  });

  it("distinguishes freestyle overlines from standard overlines", () => {
    const board = boardWith(
      [
        [2, 7],
        [3, 7],
        [4, 7],
        [6, 7],
        [7, 7],
      ],
      "black",
    );
    expect(evaluatePlacement(board, "freestyle", "black", { x: 5, y: 7 }).won).toBe(true);
    const standard = evaluatePlacement(board, "standard", "black", { x: 5, y: 7 });
    expect(standard.legal).toBe(true);
    expect(standard.won).toBe(false);
  });

  it("lets white win with an overline in renju", () => {
    const board = boardWith(
      [
        [2, 7],
        [3, 7],
        [4, 7],
        [6, 7],
        [7, 7],
      ],
      "white",
    );
    expect(evaluatePlacement(board, "renju", "white", { x: 5, y: 7 }).won).toBe(true);
  });

  it("rejects occupied and out-of-board points without changing the board", () => {
    const board = boardWith([[7, 7]], "black");
    expect(evaluatePlacement(board, "freestyle", "white", { x: 7, y: 7 }).legal).toBe(false);
    expect(evaluatePlacement(board, "freestyle", "white", { x: -1, y: 7 }).legal).toBe(false);
    expect(board[7 * 15 + 7]).toBe(BLACK);
  });
});

describe("formal renju forbidden moves", () => {
  it("rejects a black overline before considering a simultaneous five", () => {
    let board = boardWith(
      [
        [2, 7],
        [3, 7],
        [4, 7],
        [5, 7],
        [6, 7],
      ],
      "black",
    );
    board = add(
      board,
      [
        [7, 3],
        [7, 4],
        [7, 5],
        [7, 6],
      ],
      WHITE,
    );
    const result = analyzeRenjuBlackMove(board, { x: 7, y: 7 });
    expect(result).toMatchObject({ legal: false, forbiddenReason: "overline" });
  });

  it("gives an exact five priority over double-four and double-three checks", () => {
    let board = boardWith(
      [
        [3, 7],
        [4, 7],
        [5, 7],
        [6, 7],
      ],
      "black",
    );
    board = add(
      board,
      [
        [7, 5],
        [7, 6],
        [7, 8],
      ],
      BLACK,
    );
    const result = analyzeRenjuBlackMove(board, { x: 7, y: 7 });
    expect(result).toMatchObject({
      legal: true,
      createsExactFive: true,
      forbiddenReason: null,
    });
  });

  it("counts one open four once even though it has two winning endpoints", () => {
    const board = boardWith(
      [
        [5, 7],
        [6, 7],
        [8, 7],
      ],
      "black",
    );
    const result = analyzeRenjuBlackMove(board, { x: 7, y: 7 });
    expect(result).toMatchObject({ legal: true, fourCount: 1 });
  });

  it("rejects perpendicular double-fours", () => {
    const board = boardWith(
      [
        [5, 7],
        [6, 7],
        [8, 7],
        [7, 5],
        [7, 6],
        [7, 8],
      ],
      "black",
    );
    const result = analyzeRenjuBlackMove(board, { x: 7, y: 7 });
    expect(result.legal).toBe(false);
    expect(result.forbiddenReason).toBe("double_four");
    expect(result.fourCount).toBeGreaterThanOrEqual(2);
  });

  it("rejects a true perpendicular double-three", () => {
    const board = boardWith(
      [
        [6, 7],
        [8, 7],
        [7, 6],
        [7, 8],
      ],
      "black",
    );
    const result = analyzeRenjuBlackMove(board, { x: 7, y: 7 });
    expect(result.legal).toBe(false);
    expect(result.forbiddenReason).toBe("double_three");
    expect(result.threeCount).toBeGreaterThanOrEqual(2);
  });

  it("does not count an edge shape as a live three", () => {
    const board = boardWith(
      [
        [1, 7],
        [2, 7],
        [0, 6],
        [0, 8],
      ],
      "black",
    );
    const result = analyzeRenjuBlackMove(board, { x: 0, y: 7 });
    expect(result.legal).toBe(true);
    expect(result.threeCount).toBe(1);
  });

  it("does not treat blocked threes as live threes", () => {
    let board = boardWith(
      [
        [6, 7],
        [8, 7],
        [7, 6],
        [7, 8],
      ],
      "black",
    );
    board = add(
      board,
      [
        [5, 7],
        [9, 7],
      ],
      WHITE,
    );
    const result = analyzeRenjuBlackMove(board, { x: 7, y: 7 });
    expect(result.legal).toBe(true);
    expect(result.threeCount).toBe(1);
  });
});

function boardWith(points: readonly (readonly number[])[], color: GomokuColor): GomokuCell[] {
  return add(createEmptyBoard(), points, color === "black" ? BLACK : WHITE);
}

function add(
  initial: readonly GomokuCell[],
  points: readonly (readonly number[])[],
  cell: 1 | 2,
): GomokuCell[] {
  let board = [...initial];
  for (const value of points) {
    const coordinate = point(value);
    board = withStone(board, coordinate.x, coordinate.y, cell);
  }
  return board;
}

function point(value: readonly number[]): GomokuCoordinate {
  const x = value[0];
  const y = value[1];
  if (x === undefined || y === undefined) throw new Error("invalid test coordinate");
  return { x, y };
}
