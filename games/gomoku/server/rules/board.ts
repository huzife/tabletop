import {
  BOARD_POINT_COUNT,
  BOARD_SIZE,
  type GomokuCell,
  type GomokuColor,
  type GomokuCoordinate,
} from "../../shared/view.js";

export const EMPTY = 0 as const;
export const BLACK = 1 as const;
export const WHITE = 2 as const;

export const AXES = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
] as const;

export function createEmptyBoard(): GomokuCell[] {
  return Array<GomokuCell>(BOARD_POINT_COUNT).fill(EMPTY);
}

export function isInsideBoard(x: number, y: number): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    x < BOARD_SIZE &&
    y >= 0 &&
    y < BOARD_SIZE
  );
}

export function boardIndex(x: number, y: number): number {
  if (!isInsideBoard(x, y)) {
    throw new RangeError(`coordinate outside board: (${x}, ${y})`);
  }
  return y * BOARD_SIZE + x;
}

export function coordinateAt(index: number): GomokuCoordinate {
  if (!Number.isInteger(index) || index < 0 || index >= BOARD_POINT_COUNT) {
    throw new RangeError(`board index outside board: ${index}`);
  }
  return { x: index % BOARD_SIZE, y: Math.floor(index / BOARD_SIZE) };
}

export function cellAt(board: readonly GomokuCell[], x: number, y: number): GomokuCell {
  assertBoard(board);
  return board[boardIndex(x, y)] as GomokuCell;
}

export function cellAtOrBoundary(
  board: readonly GomokuCell[],
  x: number,
  y: number,
): GomokuCell | null {
  return isInsideBoard(x, y) ? (board[y * BOARD_SIZE + x] as GomokuCell) : null;
}

export function withStone(
  board: readonly GomokuCell[],
  x: number,
  y: number,
  cell: Exclude<GomokuCell, 0>,
): GomokuCell[] {
  assertBoard(board);
  const index = boardIndex(x, y);
  if (board[index] !== EMPTY) {
    throw new RangeError(`position already occupied: (${x}, ${y})`);
  }
  const next = [...board];
  next[index] = cell;
  return next;
}

export function withoutStone(board: readonly GomokuCell[], x: number, y: number): GomokuCell[] {
  assertBoard(board);
  const next = [...board];
  next[boardIndex(x, y)] = EMPTY;
  return next;
}

export function cellForColor(color: GomokuColor): Exclude<GomokuCell, 0> {
  return color === "black" ? BLACK : WHITE;
}

export function oppositeColor(color: GomokuColor): GomokuColor {
  return color === "black" ? "white" : "black";
}

export function contiguousLine(
  board: readonly GomokuCell[],
  x: number,
  y: number,
  cell: Exclude<GomokuCell, 0>,
  dx: number,
  dy: number,
): GomokuCoordinate[] {
  const before: GomokuCoordinate[] = [];
  let cursorX = x - dx;
  let cursorY = y - dy;
  while (cellAtOrBoundary(board, cursorX, cursorY) === cell) {
    before.push({ x: cursorX, y: cursorY });
    cursorX -= dx;
    cursorY -= dy;
  }

  const after: GomokuCoordinate[] = [];
  cursorX = x + dx;
  cursorY = y + dy;
  while (cellAtOrBoundary(board, cursorX, cursorY) === cell) {
    after.push({ x: cursorX, y: cursorY });
    cursorX += dx;
    cursorY += dy;
  }

  return [...before.reverse(), { x, y }, ...after];
}

export function assertBoard(board: readonly GomokuCell[]): void {
  if (board.length !== BOARD_POINT_COUNT) {
    throw new RangeError(`board must contain ${BOARD_POINT_COUNT} points`);
  }
}
