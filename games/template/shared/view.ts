import { seatIdSchema } from "@tabletop/protocol";
import { z } from "zod";

const scoreSchema = z.strictObject({ seatId: seatIdSchema, score: z.number().int().nonnegative() });

export const templateViewSchema = z.strictObject({
  activeSeatId: seatIdSchema.nullable(),
  canScore: z.boolean(),
  scores: z.array(scoreSchema).length(2),
  targetScore: z.number().int().positive(),
  viewerSeatId: seatIdSchema.nullable(),
  winnerSeatId: seatIdSchema.nullable(),
});

export const templateDisplayEventSchema = z.strictObject({
  score: z.number().int().positive(),
  seatId: seatIdSchema,
  type: z.literal("template.scored"),
});

export type TemplateView = z.infer<typeof templateViewSchema>;
export type TemplateDisplayEvent = z.infer<typeof templateDisplayEventSchema>;
