import { BOARD_POINT_COUNT, type GomokuCell, type GomokuCoordinate } from "../../shared/view.js";
import {
  AXES,
  BLACK,
  EMPTY,
  assertBoard,
  boardIndex,
  cellAtOrBoundary,
  contiguousLine,
  coordinateAt,
  isInsideBoard,
  withStone,
} from "./board.js";

export type RenjuForbiddenReason = "overline" | "double_four" | "double_three";

export interface RenjuMoveAnalysis {
  readonly legal: boolean;
  readonly forbiddenReason: RenjuForbiddenReason | null;
  readonly createsExactFive: boolean;
  readonly fourCount: number;
  readonly threeCount: number;
}

interface AnalysisEnvironment {
  readonly memo: Map<string, RenjuMoveAnalysis>;
  readonly maximumDepth: number;
}

export function analyzeRenjuBlackMove(
  board: readonly GomokuCell[],
  coordinate: GomokuCoordinate,
): RenjuMoveAnalysis {
  assertBoard(board);
  const environment: AnalysisEnvironment = {
    memo: new Map(),
    maximumDepth: board.reduce<number>((count, cell) => count + (cell === EMPTY ? 1 : 0), 0),
  };
  return analyze(board, coordinate, environment, 0);
}

export function listRenjuForbiddenMoves(
  board: readonly GomokuCell[],
): readonly (GomokuCoordinate & { readonly reason: RenjuForbiddenReason })[] {
  assertBoard(board);
  const environment: AnalysisEnvironment = {
    memo: new Map(),
    maximumDepth: board.reduce<number>((count, cell) => count + (cell === EMPTY ? 1 : 0), 0),
  };
  const result: (GomokuCoordinate & { reason: RenjuForbiddenReason })[] = [];

  for (let index = 0; index < BOARD_POINT_COUNT; index += 1) {
    if (board[index] !== EMPTY) {
      continue;
    }
    const coordinate = coordinateAt(index);
    const analysis = analyze(board, coordinate, environment, 0);
    if (!analysis.legal && analysis.forbiddenReason !== null) {
      result.push({ ...coordinate, reason: analysis.forbiddenReason });
    }
  }
  return result;
}

function analyze(
  board: readonly GomokuCell[],
  coordinate: GomokuCoordinate,
  environment: AnalysisEnvironment,
  depth: number,
): RenjuMoveAnalysis {
  if (depth > environment.maximumDepth) {
    throw new RangeError("renju legality recursion exceeded the number of empty points");
  }
  if (!isInsideBoard(coordinate.x, coordinate.y)) {
    return illegal("overline");
  }
  const index = boardIndex(coordinate.x, coordinate.y);
  if (board[index] !== EMPTY) {
    return illegal("overline");
  }

  const memoKey = `${board.join("")}:${index}`;
  const memoized = environment.memo.get(memoKey);
  if (memoized !== undefined) {
    return memoized;
  }

  const nextBoard = withStone(board, coordinate.x, coordinate.y, BLACK);
  if (createsOverline(nextBoard, coordinate)) {
    const result = illegal("overline");
    environment.memo.set(memoKey, result);
    return result;
  }

  const createsExactFive = AXES.some(
    ([dx, dy]) => contiguousLine(nextBoard, coordinate.x, coordinate.y, BLACK, dx, dy).length === 5,
  );
  if (createsExactFive) {
    const result: RenjuMoveAnalysis = {
      legal: true,
      forbiddenReason: null,
      createsExactFive: true,
      fourCount: 0,
      threeCount: 0,
    };
    environment.memo.set(memoKey, result);
    return result;
  }

  const fourCount = collectFourKeys(nextBoard, coordinate).size;
  if (fourCount >= 2) {
    const result: RenjuMoveAnalysis = {
      legal: false,
      forbiddenReason: "double_four",
      createsExactFive: false,
      fourCount,
      threeCount: 0,
    };
    environment.memo.set(memoKey, result);
    return result;
  }

  const threeCount = collectThreeKeys(nextBoard, coordinate, environment, depth + 1).size;
  const result: RenjuMoveAnalysis = {
    legal: threeCount < 2,
    forbiddenReason: threeCount >= 2 ? "double_three" : null,
    createsExactFive: false,
    fourCount,
    threeCount,
  };
  environment.memo.set(memoKey, result);
  return result;
}

function illegal(reason: RenjuForbiddenReason): RenjuMoveAnalysis {
  return {
    legal: false,
    forbiddenReason: reason,
    createsExactFive: false,
    fourCount: 0,
    threeCount: 0,
  };
}

function createsOverline(board: readonly GomokuCell[], coordinate: GomokuCoordinate): boolean {
  return AXES.some(
    ([dx, dy]) => contiguousLine(board, coordinate.x, coordinate.y, BLACK, dx, dy).length >= 6,
  );
}

function collectFourKeys(
  boardAfterMove: readonly GomokuCell[],
  move: GomokuCoordinate,
): Set<string> {
  const keys = new Set<string>();

  for (const [axisIndex, [dx, dy]] of AXES.entries()) {
    for (let moveOffset = 0; moveOffset < 5; moveOffset += 1) {
      const startX = move.x - moveOffset * dx;
      const startY = move.y - moveOffset * dy;
      const points = lineWindow(startX, startY, dx, dy, 5);
      if (points === null) {
        continue;
      }

      const black = points.filter(({ x, y }) => cellAtOrBoundary(boardAfterMove, x, y) === BLACK);
      const empty = points.filter(({ x, y }) => cellAtOrBoundary(boardAfterMove, x, y) === EMPTY);
      if (black.length !== 4 || empty.length !== 1 || !contains(black, move)) {
        continue;
      }

      const winningPoint = empty[0] as GomokuCoordinate;
      const completed = withStone(boardAfterMove, winningPoint.x, winningPoint.y, BLACK);
      if (createsOverline(completed, winningPoint)) {
        continue;
      }
      if (contiguousLine(completed, winningPoint.x, winningPoint.y, BLACK, dx, dy).length !== 5) {
        continue;
      }

      const stoneKey = black
        .map(({ x, y }) => boardIndex(x, y))
        .sort((left, right) => left - right)
        .join(",");
      keys.add(`${axisIndex}:${stoneKey}`);
    }
  }

  return keys;
}

function collectThreeKeys(
  boardAfterMove: readonly GomokuCell[],
  move: GomokuCoordinate,
  environment: AnalysisEnvironment,
  depth: number,
): Set<string> {
  const keys = new Set<string>();

  for (const [axisIndex, [dx, dy]] of AXES.entries()) {
    for (let moveOffset = 1; moveOffset <= 4; moveOffset += 1) {
      const startX = move.x - moveOffset * dx;
      const startY = move.y - moveOffset * dy;
      const points = lineWindow(startX, startY, dx, dy, 6);
      if (points === null) {
        continue;
      }
      const leftEnd = points[0] as GomokuCoordinate;
      const rightEnd = points[5] as GomokuCoordinate;
      if (
        cellAtOrBoundary(boardAfterMove, leftEnd.x, leftEnd.y) !== EMPTY ||
        cellAtOrBoundary(boardAfterMove, rightEnd.x, rightEnd.y) !== EMPTY
      ) {
        continue;
      }

      const middle = points.slice(1, 5);
      const black = middle.filter(({ x, y }) => cellAtOrBoundary(boardAfterMove, x, y) === BLACK);
      const empty = middle.filter(({ x, y }) => cellAtOrBoundary(boardAfterMove, x, y) === EMPTY);
      if (black.length !== 3 || empty.length !== 1 || !contains(black, move)) {
        continue;
      }

      const extension = empty[0] as GomokuCoordinate;
      const extensionAnalysis = analyze(boardAfterMove, extension, environment, depth);
      if (!extensionAnalysis.legal || extensionAnalysis.createsExactFive) {
        continue;
      }
      const extendedBoard = withStone(boardAfterMove, extension.x, extension.y, BLACK);
      if (!isStraightFour(extendedBoard, points, dx, dy)) {
        continue;
      }

      const stoneKey = black
        .map(({ x, y }) => boardIndex(x, y))
        .sort((left, right) => left - right)
        .join(",");
      keys.add(`${axisIndex}:${stoneKey}`);
    }
  }

  return keys;
}

function isStraightFour(
  board: readonly GomokuCell[],
  points: readonly GomokuCoordinate[],
  dx: number,
  dy: number,
): boolean {
  const left = points[0] as GomokuCoordinate;
  const right = points[5] as GomokuCoordinate;
  if (
    points.slice(1, 5).some(({ x, y }) => cellAtOrBoundary(board, x, y) !== BLACK) ||
    cellAtOrBoundary(board, left.x, left.y) !== EMPTY ||
    cellAtOrBoundary(board, right.x, right.y) !== EMPTY
  ) {
    return false;
  }

  for (const endpoint of [left, right]) {
    const won = withStone(board, endpoint.x, endpoint.y, BLACK);
    if (
      createsOverline(won, endpoint) ||
      contiguousLine(won, endpoint.x, endpoint.y, BLACK, dx, dy).length !== 5
    ) {
      return false;
    }
  }
  return true;
}

function lineWindow(
  startX: number,
  startY: number,
  dx: number,
  dy: number,
  length: number,
): GomokuCoordinate[] | null {
  const result: GomokuCoordinate[] = [];
  for (let offset = 0; offset < length; offset += 1) {
    const x = startX + offset * dx;
    const y = startY + offset * dy;
    if (!isInsideBoard(x, y)) {
      return null;
    }
    result.push({ x, y });
  }
  return result;
}

function contains(points: readonly GomokuCoordinate[], target: GomokuCoordinate): boolean {
  return points.some(({ x, y }) => x === target.x && y === target.y);
}
