import { seatIdSchema } from "@tabletop/game-sdk";
import { z } from "zod";

import { gomokuRuleSchema } from "./settings.js";

export const BOARD_SIZE = 15 as const;
export const BOARD_POINT_COUNT = BOARD_SIZE * BOARD_SIZE;

export const gomokuColorSchema = z.enum(["black", "white"]);
export const gomokuCellSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export const gomokuCoordinateSchema = z.strictObject({
  x: z.number().int().min(0).max(14),
  y: z.number().int().min(0).max(14),
});
export const gomokuEndReasonSchema = z.enum([
  "five",
  "resigned",
  "timeout",
  "disconnected",
  "left",
  "draw_agreed",
  "board_full",
]);

const moveSchema = gomokuCoordinateSchema.extend({
  color: gomokuColorSchema,
  seatId: seatIdSchema,
  moveNumber: z.number().int().positive(),
});

const playerSchema = z.strictObject({
  seatId: seatIdSchema,
  color: gomokuColorSchema,
  totalRemainingMs: z.number().nonnegative().finite().nullable(),
});

const pendingOfferSchema = z
  .strictObject({
    kind: z.enum(["undo", "draw"]),
    requesterSeatId: seatIdSchema,
    responderSeatId: seatIdSchema,
    expiresAtMonotonicMs: z.number().nonnegative().finite(),
  })
  .nullable();

const outcomeSchema = z
  .strictObject({
    winnerSeatId: seatIdSchema.nullable(),
    reason: gomokuEndReasonSchema,
  })
  .nullable();

export const gomokuViewSchema = z.strictObject({
  boardSize: z.literal(BOARD_SIZE),
  board: z.array(gomokuCellSchema).length(BOARD_POINT_COUNT),
  rule: gomokuRuleSchema,
  phase: z.enum(["playing", "undo_pending", "ended"]),
  turn: gomokuColorSchema.nullable(),
  revision: z.number().int().nonnegative(),
  serverNowMonotonicMs: z.number().nonnegative().finite(),
  moveRemainingMs: z.number().nonnegative().finite().nullable(),
  players: z.array(playerSchema).length(2),
  moves: z.array(moveSchema),
  lastMove: moveSchema.nullable(),
  forbiddenMoves: z.array(gomokuCoordinateSchema),
  winningCells: z.array(gomokuCoordinateSchema),
  pendingOffer: pendingOfferSchema,
  outcome: outcomeSchema,
  viewer: z.strictObject({
    seatId: seatIdSchema.nullable(),
    color: gomokuColorSchema.nullable(),
  }),
  legalActions: z.strictObject({
    canPlace: z.boolean(),
    canResign: z.boolean(),
    canRequestUndo: z.boolean(),
    canOfferDraw: z.boolean(),
    canRespondToOffer: z.boolean(),
  }),
});

export const gomokuDisplayEventSchema = z.discriminatedUnion("type", [
  gomokuCoordinateSchema.extend({
    type: z.literal("gomoku.stonePlaced"),
    color: gomokuColorSchema,
  }),
  gomokuCoordinateSchema.extend({
    type: z.literal("gomoku.stoneRemoved"),
  }),
  z.strictObject({
    type: z.literal("gomoku.offerCreated"),
    kind: z.enum(["undo", "draw"]),
  }),
  z.strictObject({
    type: z.literal("gomoku.offerResolved"),
    kind: z.enum(["undo", "draw"]),
    resolution: z.enum(["accepted", "rejected", "expired", "cancelled"]),
  }),
  z.strictObject({
    type: z.literal("gomoku.matchEnded"),
    winnerSeatId: seatIdSchema.nullable(),
    reason: gomokuEndReasonSchema,
  }),
]);

export type GomokuColor = z.infer<typeof gomokuColorSchema>;
export type GomokuCell = z.infer<typeof gomokuCellSchema>;
export type GomokuCoordinate = z.infer<typeof gomokuCoordinateSchema>;
export type GomokuEndReason = z.infer<typeof gomokuEndReasonSchema>;
export type GomokuView = z.infer<typeof gomokuViewSchema>;
export type GomokuDisplayEvent = z.infer<typeof gomokuDisplayEventSchema>;
