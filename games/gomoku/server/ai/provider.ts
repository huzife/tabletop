import { performance } from "node:perf_hooks";

import { type SeatId } from "@tabletop/game-sdk";
import {
  GameRuleError,
  type AutomationInputContextV1,
  type GameBotProviderV1,
  type GameFallbackControllerV1,
} from "@tabletop/game-sdk/server";
import { z } from "zod";

import type { GomokuAction } from "../../shared/actions.js";
import { gomokuRuleSchema, type GomokuRule } from "../../shared/settings.js";
import {
  BOARD_POINT_COUNT,
  gomokuCellSchema,
  gomokuColorSchema,
  gomokuCoordinateSchema,
  type GomokuCell,
  type GomokuColor,
  type GomokuCoordinate,
} from "../../shared/view.js";
import {
  EMPTY,
  AXES,
  boardIndex,
  cellAtOrBoundary,
  cellForColor,
  coordinateAt,
  oppositeColor,
} from "../rules/board.js";
import { evaluatePlacement, isWinningLength } from "../rules/evaluator.js";
import type { GomokuMatchState } from "../state.js";

export const gomokuAutomationInputSchema = z.strictObject({
  board: z.array(gomokuCellSchema).length(BOARD_POINT_COUNT),
  rule: gomokuRuleSchema,
  color: gomokuColorSchema,
  legalMoves: z.array(gomokuCoordinateSchema),
});

export type GomokuAutomationInput = z.infer<typeof gomokuAutomationInputSchema>;

const BOT_PROFILES = [
  {
    profileId: "easy",
    displayName: "简单",
    description: "优先处理直接胜负，并从邻近位置中带权选择。",
    timeBudgetMs: 100,
  },
  {
    profileId: "normal",
    displayName: "普通",
    description: "使用候选裁剪和有限深度局面搜索。",
    timeBudgetMs: 500,
  },
  {
    profileId: "hard",
    displayName: "困难",
    description: "使用迭代加深、威胁排序和更大的搜索预算。",
    timeBudgetMs: 2_000,
  },
] as const;

export const gomokuBotProvider: GameBotProviderV1<
  GomokuMatchState,
  GomokuAction,
  GomokuAutomationInput
> = {
  inputSchema: gomokuAutomationInputSchema,
  listProfiles: () => BOT_PROFILES,
  createInput: createAutomationInput,
  chooseAction: async (request) => {
    const profile = BOT_PROFILES.find(({ profileId }) => profileId === request.profileId);
    if (profile === undefined) {
      throw new RangeError(`unknown gomoku bot profile: ${request.profileId}`);
    }
    if (request.input.rule === "renju") {
      throw new GameRuleError("BOTS_NOT_ALLOWED_IN_RENJU");
    }
    return chooseAutomatedAction(
      request.input,
      profile.profileId,
      request.decisionSeed,
      request.hardDeadlineMonotonicMs,
    );
  },
};

export const gomokuFallbackController: GameFallbackControllerV1<
  GomokuMatchState,
  GomokuAction,
  GomokuAutomationInput
> = {
  inputSchema: gomokuAutomationInputSchema,
  createInput: createAutomationInput,
  chooseFallbackAction: async (request) =>
    chooseAutomatedAction(
      request.input,
      "fallback",
      request.decisionSeed,
      request.hardDeadlineMonotonicMs,
    ),
};

export function createAutomationInput(
  _context: AutomationInputContextV1,
  state: Readonly<GomokuMatchState>,
  seatId: SeatId,
): GomokuAutomationInput {
  const color = colorForSeat(state, seatId);
  const isActive =
    color !== null &&
    state.phase === "playing" &&
    state.pendingOffer?.kind !== "undo" &&
    state.turn === color;
  return {
    board: [...state.board],
    rule: state.settings.rule,
    color: color ?? "black",
    legalMoves: isActive ? getLegalMoves(state.board, state.settings.rule, color) : [],
  };
}

export function chooseAutomatedAction(
  input: Readonly<GomokuAutomationInput>,
  profileId: "easy" | "normal" | "hard" | "fallback",
  decisionSeed: string,
  hardDeadlineMonotonicMs = Number.POSITIVE_INFINITY,
): GomokuAction {
  if (input.legalMoves.length === 0) {
    return { type: "gomoku.resign" };
  }

  const winning = findImmediateMove(input.board, input.rule, input.color, input.legalMoves);
  if (winning !== null) {
    return { type: "gomoku.place", ...winning };
  }
  const opponent = oppositeColor(input.color);
  const blocking = input.legalMoves.find(
    (move) => evaluatePlacement(input.board, input.rule, opponent, move).won,
  );
  if (blocking !== undefined) {
    return { type: "gomoku.place", ...blocking };
  }

  if (profileId === "easy" || profileId === "fallback" || input.rule === "renju") {
    return {
      type: "gomoku.place",
      ...pickWeightedCandidate(input.board, input.legalMoves, decisionSeed),
    };
  }

  const maximumDepth = profileId === "normal" ? 2 : 4;
  const nodeBudget = profileId === "normal" ? 4_000 : 30_000;
  const candidateLimit = profileId === "normal" ? 20 : 28;
  const counter = { visited: 0, budget: nodeBudget, hardDeadlineMonotonicMs };
  let best = orderCandidates(
    input.board,
    input.rule,
    input.color,
    input.legalMoves,
    candidateLimit,
  )[0] as GomokuCoordinate;

  for (let depth = 1; depth <= maximumDepth; depth += 1) {
    const result = searchRoot(
      input.board,
      input.rule,
      input.color,
      input.legalMoves,
      depth,
      candidateLimit,
      counter,
    );
    if (!result.completed) {
      break;
    }
    best = result.move;
  }
  return { type: "gomoku.place", ...best };
}

function searchRoot(
  board: readonly GomokuCell[],
  rule: GomokuRule,
  color: GomokuColor,
  legalMoves: readonly GomokuCoordinate[],
  depth: number,
  candidateLimit: number,
  counter: SearchCounter,
): { readonly completed: boolean; readonly move: GomokuCoordinate } {
  const candidates = orderCandidates(board, rule, color, legalMoves, candidateLimit);
  let best = candidates[0] as GomokuCoordinate;
  let bestScore = Number.NEGATIVE_INFINITY;
  let alpha = Number.NEGATIVE_INFINITY;

  for (const move of candidates) {
    if (searchBudgetExhausted(counter)) {
      return { completed: false, move: best };
    }
    const evaluation = evaluatePlacement(board, rule, color, move);
    if (!evaluation.legal) {
      continue;
    }
    const score = evaluation.won
      ? 1_000_000_000
      : -negamax(
          evaluation.board,
          rule,
          oppositeColor(color),
          color,
          depth - 1,
          Number.NEGATIVE_INFINITY,
          -alpha,
          candidateLimit,
          counter,
        );
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
    alpha = Math.max(alpha, score);
  }
  return { completed: !searchBudgetExhausted(counter), move: best };
}

interface SearchCounter {
  visited: number;
  readonly budget: number;
  readonly hardDeadlineMonotonicMs: number;
}

function negamax(
  board: readonly GomokuCell[],
  rule: GomokuRule,
  toMove: GomokuColor,
  rootColor: GomokuColor,
  depth: number,
  alphaStart: number,
  beta: number,
  candidateLimit: number,
  counter: SearchCounter,
): number {
  counter.visited += 1;
  if (searchBudgetExhausted(counter) || depth <= 0) {
    const score = evaluateBoard(board, rule, rootColor);
    return toMove === rootColor ? score : -score;
  }

  const legal = getLegalMoves(board, rule, toMove);
  if (legal.length === 0) {
    return 0;
  }
  const candidates = orderCandidates(board, rule, toMove, legal, candidateLimit);
  let alpha = alphaStart;
  let best = Number.NEGATIVE_INFINITY;
  for (const move of candidates) {
    if (searchBudgetExhausted(counter)) {
      break;
    }
    const evaluation = evaluatePlacement(board, rule, toMove, move);
    if (!evaluation.legal) {
      continue;
    }
    const score = evaluation.won
      ? 900_000_000 + depth
      : -negamax(
          evaluation.board,
          rule,
          oppositeColor(toMove),
          rootColor,
          depth - 1,
          -beta,
          -alpha,
          candidateLimit,
          counter,
        );
    best = Math.max(best, score);
    alpha = Math.max(alpha, score);
    if (alpha >= beta) {
      break;
    }
  }
  return best;
}

function searchBudgetExhausted(counter: Readonly<SearchCounter>): boolean {
  return counter.visited >= counter.budget || performance.now() >= counter.hardDeadlineMonotonicMs;
}

function getLegalMoves(
  board: readonly GomokuCell[],
  rule: GomokuRule,
  color: GomokuColor,
): GomokuCoordinate[] {
  const candidates = neighborhoodCandidates(board);
  return candidates.filter((move) => evaluatePlacement(board, rule, color, move).legal);
}

function neighborhoodCandidates(board: readonly GomokuCell[]): GomokuCoordinate[] {
  if (board.every((cell) => cell === EMPTY)) {
    return [{ x: 7, y: 7 }];
  }
  const nearby = new Set<number>();
  for (let index = 0; index < board.length; index += 1) {
    if (board[index] === EMPTY) {
      continue;
    }
    const origin = coordinateAt(index);
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const x = origin.x + dx;
        const y = origin.y + dy;
        if (x >= 0 && x < 15 && y >= 0 && y < 15 && board[y * 15 + x] === EMPTY) {
          nearby.add(y * 15 + x);
        }
      }
    }
  }
  if (nearby.size > 0) {
    return [...nearby].map(coordinateAt);
  }
  return board
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => cell === EMPTY)
    .map(({ index }) => coordinateAt(index));
}

function orderCandidates(
  board: readonly GomokuCell[],
  rule: GomokuRule,
  color: GomokuColor,
  moves: readonly GomokuCoordinate[],
  limit: number,
): GomokuCoordinate[] {
  return [...moves]
    .map((move) => {
      const own = evaluatePlacement(board, rule, color, move);
      const opponent = evaluatePlacement(board, rule, oppositeColor(color), move);
      const centerDistance = Math.abs(move.x - 7) + Math.abs(move.y - 7);
      return {
        move,
        score:
          (own.won ? 10_000_000 : 0) +
          (opponent.won ? 5_000_000 : 0) +
          adjacentStoneCount(board, move) * 1_000 -
          centerDistance,
      };
    })
    .sort((left, right) => right.score - left.score || compareCoordinates(left.move, right.move))
    .slice(0, limit)
    .map(({ move }) => move);
}

function findImmediateMove(
  board: readonly GomokuCell[],
  rule: GomokuRule,
  color: GomokuColor,
  moves: readonly GomokuCoordinate[],
): GomokuCoordinate | null {
  return moves.find((move) => evaluatePlacement(board, rule, color, move).won) ?? null;
}

function pickWeightedCandidate(
  board: readonly GomokuCell[],
  moves: readonly GomokuCoordinate[],
  seed: string,
): GomokuCoordinate {
  const weighted = moves.map((move) => ({
    move,
    weight: Math.max(
      1,
      30 + adjacentStoneCount(board, move) * 20 - (Math.abs(move.x - 7) + Math.abs(move.y - 7)),
    ),
  }));
  const total = weighted.reduce((sum, { weight }) => sum + weight, 0);
  let cursor = stableHash(seed) % total;
  for (const candidate of weighted) {
    if (cursor < candidate.weight) {
      return candidate.move;
    }
    cursor -= candidate.weight;
  }
  return weighted[0]?.move ?? { x: 7, y: 7 };
}

function adjacentStoneCount(board: readonly GomokuCell[], move: GomokuCoordinate): number {
  let count = 0;
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const cell = cellAtOrBoundary(board, move.x + dx, move.y + dy);
      if (cell !== null && cell !== EMPTY) {
        count += 1;
      }
    }
  }
  return count;
}

function evaluateBoard(
  board: readonly GomokuCell[],
  rule: GomokuRule,
  rootColor: GomokuColor,
): number {
  return (
    scoreRuns(board, rule, rootColor) - scoreRuns(board, rule, oppositeColor(rootColor)) * 1.15
  );
}

function scoreRuns(board: readonly GomokuCell[], rule: GomokuRule, color: GomokuColor): number {
  const cell = cellForColor(color);
  let score = 0;
  for (let index = 0; index < board.length; index += 1) {
    if (board[index] !== cell) {
      continue;
    }
    const point = coordinateAt(index);
    for (const [dx, dy] of AXES) {
      if (cellAtOrBoundary(board, point.x - dx, point.y - dy) === cell) {
        continue;
      }
      let length = 0;
      while (cellAtOrBoundary(board, point.x + length * dx, point.y + length * dy) === cell) {
        length += 1;
      }
      const openEnds =
        Number(cellAtOrBoundary(board, point.x - dx, point.y - dy) === EMPTY) +
        Number(cellAtOrBoundary(board, point.x + length * dx, point.y + length * dy) === EMPTY);
      score += runScore(rule, color, length, openEnds);
    }
  }
  return score;
}

function runScore(rule: GomokuRule, color: GomokuColor, length: number, openEnds: number): number {
  if (isWinningLength(rule, color, length)) return 10_000_000;
  if (length >= 6) return 80;
  if (length === 4) return openEnds === 2 ? 120_000 : openEnds === 1 ? 24_000 : 100;
  if (length === 3) return openEnds === 2 ? 7_000 : openEnds === 1 ? 1_200 : 50;
  if (length === 2) return openEnds === 2 ? 500 : openEnds === 1 ? 100 : 10;
  return openEnds === 2 ? 12 : 2;
}

function colorForSeat(state: Readonly<GomokuMatchState>, seatId: SeatId): GomokuColor | null {
  if (state.seatByColor.black === seatId) return "black";
  if (state.seatByColor.white === seatId) return "white";
  return null;
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function compareCoordinates(left: GomokuCoordinate, right: GomokuCoordinate): number {
  return boardIndex(left.x, left.y) - boardIndex(right.x, right.y);
}
