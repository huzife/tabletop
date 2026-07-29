import type { SeatId } from "@tabletop/protocol";
import type {
  AutomationInputContextV1,
  GameBotProviderV1,
  GameFallbackControllerV1,
} from "@tabletop/game-sdk/server";
import { z } from "zod";

import {
  doudizhuCardSchema,
  doudizhuPlayPatternSchema,
  enumerateDoudizhuPlays,
  rankStrength,
  type DoudizhuAction,
  type DoudizhuCard,
  type DoudizhuPlayPattern,
  type DoudizhuRole,
} from "../shared/index.js";
import type { DoudizhuState } from "./state.js";

export const DOUDIZHU_BOT_ACTION_DELAY_MS = 450;
const DOUDIZHU_BOT_TIME_BUDGET_MS = 1_000;

const publicLastPlaySchema = z.strictObject({
  seatId: z.string().min(1).max(128),
  cards: z.array(doudizhuCardSchema).min(1).max(20),
  pattern: doudizhuPlayPatternSchema,
});

export const doudizhuAutomationInputSchema = z.strictObject({
  seatId: z.string().min(1).max(128),
  phase: z.enum(["bidding", "open_hand", "doubling", "playing"]),
  bidMode: z.enum(["call", "rob", "counter"]).nullable(),
  hand: z.array(doudizhuCardSchema).max(20),
  lastPlay: publicLastPlaySchema.nullable(),
  landlordSeatId: z.string().min(1).max(128).nullable(),
  seatOrder: z.array(z.string().min(1).max(128)).length(3),
  cardCounts: z.array(
    z.strictObject({
      seatId: z.string().min(1).max(128),
      cardCount: z.number().int().min(0).max(20),
    }),
  ),
});
export type DoudizhuAutomationInput = z.infer<typeof doudizhuAutomationInputSchema>;

function createInput(
  _context: AutomationInputContextV1,
  state: Readonly<DoudizhuState>,
  seatId: SeatId,
): DoudizhuAutomationInput {
  if (state.activeSeatId !== seatId || state.phase === "ended") {
    throw new RangeError("automation requested for an inactive doudizhu seat");
  }
  return {
    seatId,
    phase: state.phase,
    bidMode: state.phase === "bidding" ? bidMode(state) : null,
    hand: (state.hands[seatId] ?? []).map((card) => ({ ...card })),
    lastPlay:
      state.lastPlay === null
        ? null
        : {
            seatId: state.lastPlay.seatId,
            cards: state.lastPlay.cards.map((card) => ({ ...card })),
            pattern: { ...state.lastPlay.pattern },
          },
    landlordSeatId: state.landlordSeatId,
    seatOrder: [...state.seatOrder],
    cardCounts: state.seatOrder.map((candidateSeatId) => ({
      seatId: candidateSeatId,
      cardCount: state.hands[candidateSeatId]?.length ?? 0,
    })),
  };
}

function choose(input: DoudizhuAutomationInput, seed: string): DoudizhuAction {
  const strength = handStrength(input.hand);
  if (input.phase === "bidding") {
    const threshold = input.bidMode === "call" ? 10 : input.bidMode === "rob" ? 14 : 17;
    if (strength < threshold) return { type: "doudizhu.bid.pass" };
    return {
      type: input.bidMode === "call" ? "doudizhu.bid.call" : "doudizhu.bid.rob",
    };
  }
  if (input.phase === "open_hand") {
    return { type: "doudizhu.open-hand", open: strength >= 18 };
  }
  if (input.phase === "doubling") {
    return { type: "doudizhu.double", double: strength >= 14 };
  }
  return choosePlay(input, seed);
}

function choosePlay(input: DoudizhuAutomationInput, seed: string): DoudizhuAction {
  const role = roleFor(input.seatId, input.landlordSeatId);
  const previous =
    input.lastPlay !== null && input.lastPlay.seatId !== input.seatId
      ? input.lastPlay.pattern
      : null;
  const canPass = previous !== null;
  if (
    canPass &&
    role === "farmer" &&
    input.lastPlay !== null &&
    roleFor(input.lastPlay.seatId, input.landlordSeatId) === "farmer" &&
    input.lastPlay.cards.length < (cardCount(input, input.lastPlay.seatId) ?? 20) &&
    (cardCount(input, input.landlordSeatId) ?? 20) > 2
  ) {
    return { type: "doudizhu.pass" };
  }

  const plays = enumerateDoudizhuPlays(input.hand, previous);
  if (plays.length === 0) return { type: "doudizhu.pass" };
  const urgentLandlord = role === "farmer" && (cardCount(input, input.landlordSeatId) ?? 20) <= 2;
  const scored = plays.map((play) => ({
    ...play,
    score: scorePlay(play.cards, play.pattern, input.hand.length, previous, urgentLandlord),
  }));
  const highest = Math.max(...scored.map(({ score }) => score));
  const best = scored.filter(({ score }) => score === highest);
  const selected = best[seedIndex(seed, best.length)] ?? best[0];
  if (!selected)
    return canPass ? { type: "doudizhu.pass" } : { type: "doudizhu.play", cardIds: [] };
  return { type: "doudizhu.play", cardIds: selected.cards.map(({ id }) => id) };
}

function scorePlay(
  cards: readonly DoudizhuCard[],
  pattern: DoudizhuPlayPattern,
  handSize: number,
  previous: DoudizhuPlayPattern | null,
  urgentLandlord: boolean,
): number {
  if (cards.length === handSize) return 1_000_000;
  const special = pattern.kind === "bomb" || pattern.kind === "rocket";
  let score = cards.length * 120 - rankStrength(pattern.mainRank) * 4;
  if (pattern.sequenceLength > 1) score += pattern.sequenceLength * 40;
  if (special) score -= urgentLandlord ? 20 : 700;
  if (previous !== null) score -= cards.length * 100;
  if (urgentLandlord) score += rankStrength(pattern.mainRank) * 12;
  return score;
}

export function handStrength(hand: readonly DoudizhuCard[]): number {
  const byRank = new Map<string, number>();
  for (const card of hand) byRank.set(card.rank, (byRank.get(card.rank) ?? 0) + 1);
  const bombs = [...byRank.values()].filter((count) => count === 4).length;
  const rocket = byRank.has("small-joker") && byRank.has("big-joker");
  const highCards =
    (byRank.get("2") ?? 0) * 2 +
    (byRank.get("A") ?? 0) +
    (byRank.has("big-joker") ? 3 : 0) +
    (byRank.has("small-joker") ? 2 : 0);
  const longPlays = enumerateDoudizhuPlays(hand).filter(
    ({ pattern }) => pattern.sequenceLength >= 2,
  );
  const longest = Math.max(0, ...longPlays.map(({ cards }) => cards.length));
  return bombs * 6 + (rocket ? 8 : 0) + highCards + Math.min(4, Math.floor(longest / 3));
}

function bidMode(state: Readonly<DoudizhuState>): "call" | "rob" | "counter" {
  if (state.bid.stage === "seeking") return "call";
  return state.bid.stage === "counter" ? "counter" : "rob";
}

function roleFor(seatId: string, landlordSeatId: string | null): DoudizhuRole | null {
  if (landlordSeatId === null) return null;
  return seatId === landlordSeatId ? "landlord" : "farmer";
}

function cardCount(input: DoudizhuAutomationInput, seatId: string | null): number | undefined {
  if (seatId === null) return undefined;
  return input.cardCounts.find((entry) => entry.seatId === seatId)?.cardCount;
}

function seedIndex(seed: string, length: number): number {
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % Math.max(1, length);
}

export const doudizhuBotProvider: GameBotProviderV1<
  DoudizhuState,
  DoudizhuAction,
  DoudizhuAutomationInput
> = {
  inputSchema: doudizhuAutomationInputSchema,
  listProfiles: () => [
    {
      profileId: "standard",
      displayName: "标准 AI",
      description: "按牌力叫抢，兼顾手数、控制牌、炸弹保留与农民协作。",
      timeBudgetMs: DOUDIZHU_BOT_TIME_BUDGET_MS,
    },
  ],
  createInput,
  async chooseAction(request) {
    if (request.profileId !== "standard") throw new RangeError("unknown doudizhu bot profile");
    await new Promise<void>((resolve) => setTimeout(resolve, DOUDIZHU_BOT_ACTION_DELAY_MS));
    return choose(request.input, request.decisionSeed);
  },
};

export const doudizhuFallbackController: GameFallbackControllerV1<
  DoudizhuState,
  DoudizhuAction,
  DoudizhuAutomationInput
> = {
  inputSchema: doudizhuAutomationInputSchema,
  createInput,
  async chooseFallbackAction(request) {
    return choose(request.input, request.decisionSeed);
  },
};
