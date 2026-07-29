import { seatIdSchema } from "@tabletop/protocol";
import { z } from "zod";

import { doudizhuCardSchema, doudizhuPlayKindSchema, doudizhuPlayPatternSchema } from "./cards.js";

export const doudizhuPhaseSchema = z.enum(["bidding", "open_hand", "doubling", "playing", "ended"]);
export type DoudizhuPhase = z.infer<typeof doudizhuPhaseSchema>;

export const doudizhuRoleSchema = z.enum(["landlord", "farmer"]);
export type DoudizhuRole = z.infer<typeof doudizhuRoleSchema>;

export const doudizhuControllerSchema = z.enum(["human", "bot", "temporary_ai", "persistent_ai"]);
export type DoudizhuController = z.infer<typeof doudizhuControllerSchema>;

const seatViewSchema = z.strictObject({
  seatId: seatIdSchema,
  role: doudizhuRoleSchema.nullable(),
  controller: doudizhuControllerSchema,
  reclaimable: z.boolean(),
  cardCount: z.number().int().min(0).max(20),
  isCurrent: z.boolean(),
  doubled: z.boolean(),
});

const visibleHandSchema = z.strictObject({
  seatId: seatIdSchema,
  cards: z.array(doudizhuCardSchema).max(20),
});

const publicPlaySchema = z.strictObject({
  seatId: seatIdSchema,
  cards: z.array(doudizhuCardSchema).min(1).max(20),
  pattern: doudizhuPlayPatternSchema,
});

const scoreSchema = z.strictObject({
  seatId: seatIdSchema,
  score: z.number().int(),
  relationMultiplier: z.number().int().positive(),
});

const outcomeSchema = z.strictObject({
  winnerSide: z.enum(["landlord", "farmers"]),
  winningSeatId: seatIdSchema,
  spring: z.enum(["landlord", "farmers"]).nullable(),
  commonMultiplier: z.number().int().positive(),
  scores: z.array(scoreSchema).length(3),
});

export const doudizhuViewSchema = z.strictObject({
  phase: doudizhuPhaseSchema,
  revision: z.number().int().nonnegative(),
  dealNumber: z.number().int().positive(),
  activeSeatId: seatIdSchema.nullable(),
  viewerSeatId: seatIdSchema.nullable(),
  landlordSeatId: seatIdSchema.nullable(),
  initialCallerSeatId: seatIdSchema.nullable(),
  seats: z.array(seatViewSchema).length(3),
  viewerHand: z.array(doudizhuCardSchema).max(20),
  visibleHands: z.array(visibleHandSchema).max(3),
  bottomCards: z.array(doudizhuCardSchema).max(3),
  lastPlay: publicPlaySchema.nullable(),
  passedSeatIds: z.array(seatIdSchema).max(2),
  multiplier: z.strictObject({
    common: z.number().int().positive(),
    robCount: z.number().int().nonnegative().max(3),
    openHand: z.boolean(),
    bombCount: z.number().int().nonnegative(),
    spring: z.enum(["landlord", "farmers"]).nullable(),
  }),
  legalActions: z.strictObject({
    canCall: z.boolean(),
    canRob: z.boolean(),
    canPassBid: z.boolean(),
    canChooseOpenHand: z.boolean(),
    canDouble: z.boolean(),
    canPlay: z.boolean(),
    canPass: z.boolean(),
  }),
  outcome: outcomeSchema.nullable(),
});

const bidEventSchema = z.strictObject({
  type: z.literal("doudizhu.bid.changed"),
  seatId: seatIdSchema,
  decision: z.enum(["call", "rob", "counter", "pass"]),
  robCount: z.number().int().nonnegative().max(3),
});

export const doudizhuDisplayEventSchema = z.discriminatedUnion("type", [
  bidEventSchema,
  z.strictObject({
    type: z.literal("doudizhu.dealt"),
    dealNumber: z.number().int().positive(),
  }),
  z.strictObject({
    type: z.literal("doudizhu.landlord.selected"),
    seatId: seatIdSchema,
    bottomCards: z.array(doudizhuCardSchema).length(3),
  }),
  z.strictObject({
    type: z.literal("doudizhu.hand.revealed"),
    seatId: seatIdSchema,
    open: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("doudizhu.double.selected"),
    seatId: seatIdSchema,
    doubled: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("doudizhu.cards.played"),
    seatId: seatIdSchema,
    cards: z.array(doudizhuCardSchema).min(1).max(20),
    patternKind: doudizhuPlayKindSchema,
  }),
  z.strictObject({
    type: z.literal("doudizhu.turn.passed"),
    seatId: seatIdSchema,
  }),
  z.strictObject({
    type: z.literal("doudizhu.match.completed"),
    winnerSide: z.enum(["landlord", "farmers"]),
    commonMultiplier: z.number().int().positive(),
  }),
]);

export type DoudizhuView = z.infer<typeof doudizhuViewSchema>;
export type DoudizhuDisplayEvent = z.infer<typeof doudizhuDisplayEventSchema>;
export type DoudizhuOutcomeView = z.infer<typeof outcomeSchema>;
