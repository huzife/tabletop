import { z } from "zod";

export const gomokuActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("gomoku.place"),
    x: z.number().int().min(0).max(14),
    y: z.number().int().min(0).max(14),
  }),
  z.strictObject({ type: z.literal("gomoku.resign") }),
  z.strictObject({ type: z.literal("gomoku.undo.request") }),
  z.strictObject({
    type: z.literal("gomoku.undo.respond"),
    accept: z.boolean(),
  }),
  z.strictObject({ type: z.literal("gomoku.draw.offer") }),
  z.strictObject({
    type: z.literal("gomoku.draw.respond"),
    accept: z.boolean(),
  }),
]);

export type GomokuAction = z.infer<typeof gomokuActionSchema>;
