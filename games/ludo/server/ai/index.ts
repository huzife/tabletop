import type { SeatId } from "@tabletop/game-sdk";
import type {
  AutomationInputContextV1,
  GameBotProviderV1,
  GameFallbackControllerV1,
} from "@tabletop/game-sdk/server";
import { z } from "zod";

import { planeIdSchema, type LudoAction, type PlaneId } from "../../shared/index.js";
import { globalMainIndex, MAIN_PATH_LENGTH } from "../../shared/board.js";
import { cloneLudoState, requirePlane, requireSeat, type LudoState } from "../rules/state.js";
import { getLegalPlaneIds, resolvePlaneAction } from "../rules/movement.js";

export const LUDO_BOT_ACTION_DELAY_MS = 500;
const LUDO_BOT_TIME_BUDGET_MS = 750;

const candidateSchema = z.strictObject({
  planeId: planeIdSchema,
  score: z.number().finite(),
});

export const ludoAutomationInputSchema = z.strictObject({
  phase: z.enum(["waiting_roll", "selecting_plane"]),
  seatId: z.string().min(1).max(128),
  roll: z.number().int().min(1).max(6).nullable(),
  candidates: z.array(candidateSchema),
});
export type LudoAutomationInput = z.infer<typeof ludoAutomationInputSchema>;

function createInput(
  _context: AutomationInputContextV1,
  state: Readonly<LudoState>,
  seatId: SeatId,
): LudoAutomationInput {
  if (state.currentSeatId !== seatId) {
    throw new RangeError("automation requested for an inactive ludo seat");
  }
  if (state.phase === "waiting_roll") {
    return { phase: "waiting_roll", seatId, roll: null, candidates: [] };
  }
  if (state.phase !== "selecting_plane" || state.roll === null) {
    throw new RangeError("ludo automation requested outside an actionable phase");
  }
  const legal = getLegalPlaneIds(state, seatId, state.roll);
  return {
    phase: "selecting_plane",
    seatId,
    roll: state.roll,
    candidates: legal.map((planeId) => ({
      planeId,
      score: scoreCandidate(state, seatId, planeId, state.roll as number),
    })),
  };
}

function choose(input: LudoAutomationInput, seed: string): LudoAction {
  if (input.phase === "waiting_roll") return { type: "roll" };
  if (input.candidates.length === 0) throw new RangeError("no legal ludo automation candidate");
  const highest = Math.max(...input.candidates.map((candidate) => candidate.score));
  const best = input.candidates.filter((candidate) => candidate.score === highest);
  const selected = best[seedIndex(seed, best.length)];
  if (selected === undefined) throw new Error("ludo automation selection failed");
  return { type: "select_plane", planeId: selected.planeId };
}

export const ludoBotProvider: GameBotProviderV1<LudoState, LudoAction, LudoAutomationInput> = {
  inputSchema: ludoAutomationInputSchema,
  listProfiles: () => [
    {
      profileId: "standard",
      displayName: "规则 AI",
      description: "优先完成、吃子、飞行、跳跃和安全推进。",
      timeBudgetMs: LUDO_BOT_TIME_BUDGET_MS,
    },
  ],
  createInput,
  async chooseAction(request) {
    if (request.profileId !== "standard") throw new RangeError("unknown ludo bot profile");
    await new Promise<void>((resolve) => setTimeout(resolve, LUDO_BOT_ACTION_DELAY_MS));
    return choose(request.input, request.decisionSeed);
  },
};

export const ludoFallbackController: GameFallbackControllerV1<
  LudoState,
  LudoAction,
  LudoAutomationInput
> = {
  inputSchema: ludoAutomationInputSchema,
  createInput,
  async chooseFallbackAction(request) {
    return choose(request.input, request.decisionSeed);
  },
};

export function scoreCandidate(
  state: Readonly<LudoState>,
  seatId: SeatId,
  planeId: PlaneId,
  roll: number,
): number {
  const before = requirePlane(state, planeId);
  const beforeProgress = progressScore(before);
  const simulation = cloneLudoState(state);
  const steps = resolvePlaneAction(simulation, planeId, roll);
  const after = requirePlane(simulation, planeId);
  let score = (progressScore(after) - beforeProgress) * 100;

  if (steps.some((step) => step.type === "finish")) score += 100_000;
  for (const step of steps) {
    if (step.type === "capture") {
      score += step.mutual ? -30_000 : 50_000 + step.capturedPlaneIds.length * 2_000;
    } else if (step.type === "fly") {
      score += 20_000;
    } else if (step.type === "jump") {
      score += 10_000;
    } else if (step.type === "launch") {
      score += 5_000;
    }
  }
  score -= landingRisk(simulation, seatId, after) * 500;
  return score;
}

function progressScore(plane: ReturnType<typeof requirePlane>): number {
  switch (plane.position.region) {
    case "BASE":
      return -2;
    case "APRON":
      return -1;
    case "MAIN_PATH":
      return plane.position.pathIndex;
    case "HOME_PATH":
      return MAIN_PATH_LENGTH + plane.position.pathIndex;
    case "FINISHED":
      return 100;
  }
}

function landingRisk(
  state: Readonly<LudoState>,
  seatId: SeatId,
  plane: ReturnType<typeof requirePlane>,
): number {
  if (plane.position.region !== "MAIN_PATH") return 0;
  const target = globalMainIndex(plane.color, plane.position.pathIndex);
  const ownColor = requireSeat(state, seatId).color;
  return state.planes.filter((enemy) => {
    if (enemy.color === ownColor || enemy.position.region !== "MAIN_PATH") return false;
    for (let distance = 1; distance <= 6; distance += 1) {
      if (enemy.position.pathIndex + distance >= MAIN_PATH_LENGTH) break;
      const candidate = globalMainIndex(enemy.color, enemy.position.pathIndex + distance);
      if (candidate === target) return true;
    }
    return false;
  }).length;
}

function seedIndex(seed: string, length: number): number {
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % length;
}
