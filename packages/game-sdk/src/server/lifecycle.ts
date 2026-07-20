import { jsonValueSchema, seatIdSchema } from "@tabletop/protocol";
import { z } from "zod";

export const gameDeadlineV1Schema = z.strictObject({
  deadlineId: z.string().min(1).max(128),
  dueAtMonotonicMs: z.number().nonnegative().finite(),
  payload: jsonValueSchema.optional(),
});

export const gameSystemEventV1Schema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("connection.lost"),
    seatId: seatIdSchema,
    graceDeadlineMs: z.number().nonnegative().finite(),
  }),
  z.strictObject({
    type: z.literal("connection.restored"),
    seatId: seatIdSchema,
  }),
  z.strictObject({
    type: z.literal("connection.grace_expired"),
    seatId: seatIdSchema,
  }),
  z.strictObject({
    type: z.literal("seat.reclaim_requested"),
    seatId: seatIdSchema,
  }),
  z.strictObject({
    type: z.literal("member.left"),
    seatId: seatIdSchema,
  }),
]);

export const gameRoomDirectiveV1Schema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("seat.useFallbackController"),
    seatId: seatIdSchema,
  }),
  z.strictObject({
    type: z.literal("seat.returnHumanControl"),
    seatId: seatIdSchema,
  }),
  z.strictObject({
    type: z.literal("seat.release"),
    seatId: seatIdSchema,
  }),
  z.strictObject({
    type: z.literal("seat.setReclaimable"),
    seatId: seatIdSchema,
    reclaimable: z.boolean(),
  }),
]);

export const gameOutcomeV1Schema = z.strictObject({
  kind: z.literal("completed"),
  publicSummary: jsonValueSchema.optional(),
});

export type GameTransitionV1<TState, TDisplayEvent> =
  | {
      readonly kind: "noop";
      readonly state: TState;
    }
  | {
      readonly kind: "applied";
      readonly state: TState;
      readonly events: readonly TDisplayEvent[];
      readonly outcome?: GameOutcomeV1;
      readonly roomDirectives?: readonly GameRoomDirectiveV1[];
    };

export type GameDeadlineV1 = z.infer<typeof gameDeadlineV1Schema>;
export type GameOutcomeV1 = z.infer<typeof gameOutcomeV1Schema>;
export type GameRoomDirectiveV1 = z.infer<typeof gameRoomDirectiveV1Schema>;
export type GameSystemEventV1 = z.infer<typeof gameSystemEventV1Schema>;
