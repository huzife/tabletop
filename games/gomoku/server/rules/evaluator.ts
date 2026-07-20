import type { GomokuCell, GomokuColor, GomokuCoordinate } from "../../shared/view.js";
import type { GomokuRule } from "../../shared/settings.js";
import {
  AXES,
  EMPTY,
  assertBoard,
  boardIndex,
  cellForColor,
  contiguousLine,
  isInsideBoard,
  withStone,
} from "./board.js";
import {
  analyzeRenjuBlackMove,
  listRenjuForbiddenMoves,
  type RenjuForbiddenReason,
} from "./renju.js";

export interface PlacementEvaluation {
  readonly legal: boolean;
  readonly forbiddenReason: RenjuForbiddenReason | null;
  readonly board: readonly GomokuCell[];
  readonly won: boolean;
  readonly winningCells: readonly GomokuCoordinate[];
}

export function evaluatePlacement(
  board: readonly GomokuCell[],
  rule: GomokuRule,
  color: GomokuColor,
  coordinate: GomokuCoordinate,
): PlacementEvaluation {
  assertBoard(board);
  if (
    !isInsideBoard(coordinate.x, coordinate.y) ||
    board[boardIndex(coordinate.x, coordinate.y)] !== EMPTY
  ) {
    return {
      legal: false,
      forbiddenReason: null,
      board,
      won: false,
      winningCells: [],
    };
  }

  if (rule === "renju" && color === "black") {
    const analysis = analyzeRenjuBlackMove(board, coordinate);
    if (!analysis.legal) {
      return {
        legal: false,
        forbiddenReason: analysis.forbiddenReason,
        board,
        won: false,
        winningCells: [],
      };
    }
  }

  const cell = cellForColor(color);
  const nextBoard = withStone(board, coordinate.x, coordinate.y, cell);
  const lines = AXES.map(([dx, dy]) =>
    contiguousLine(nextBoard, coordinate.x, coordinate.y, cell, dx, dy),
  ).filter((line) => isWinningLength(rule, color, line.length));
  const uniqueCells = new Map<number, GomokuCoordinate>();
  for (const line of lines) {
    for (const point of line) {
      uniqueCells.set(boardIndex(point.x, point.y), point);
    }
  }

  return {
    legal: true,
    forbiddenReason: null,
    board: nextBoard,
    won: lines.length > 0,
    winningCells: [...uniqueCells.values()],
  };
}

export function getRenjuForbiddenCoordinates(
  board: readonly GomokuCell[],
): readonly GomokuCoordinate[] {
  return listRenjuForbiddenMoves(board).map(({ x, y }) => ({ x, y }));
}

export function isWinningLength(rule: GomokuRule, color: GomokuColor, length: number): boolean {
  if (rule === "freestyle") {
    return length >= 5;
  }
  if (rule === "standard") {
    return length === 5;
  }
  return color === "black" ? length === 5 : length >= 5;
}
