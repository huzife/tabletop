import { z } from "zod";

export const snookerColorSchema = z.enum(["yellow", "green", "brown", "blue", "pink", "black"]);
export type SnookerColor = z.infer<typeof snookerColorSchema>;

// Shooter-view cue-ball face: X is left-negative/right-positive and Y is
// bottom-negative/top-positive.
export const cueTipSchema = z
  .strictObject({
    x: z.number().finite().min(-0.95).max(0.95),
    y: z.number().finite().min(-0.95).max(0.95),
  })
  .refine(({ x, y }) => x * x + y * y <= 0.95 * 0.95, {
    message: "cue tip offset must stay inside the cue-ball face",
  });
export type CueTip = z.infer<typeof cueTipSchema>;

export const billiardsShotSchema = z.strictObject({
  angle: z.number().finite().min(-Math.PI).max(Math.PI),
  elevation: z.number().finite().min(0).max(90),
  nominatedColor: snookerColorSchema.nullable(),
  power: z.number().finite().min(1).max(100),
  tip: cueTipSchema,
});
export type BilliardsShot = z.infer<typeof billiardsShotSchema>;

export const billiardsBreakChoiceSchema = z.enum([
  "accept-table",
  "take-line-in-hand",
  "spot-eight",
  "rerack-self",
  "rerack-opponent",
]);
export type BilliardsBreakChoice = z.infer<typeof billiardsBreakChoiceSchema>;

export const billiardsSelectableGroupSchema = z.enum(["solids", "stripes"]);
export type BilliardsSelectableGroup = z.infer<typeof billiardsSelectableGroupSchema>;

export const billiardsDecidingBlackChoiceSchema = z.enum(["play-self", "defer"]);
export type BilliardsDecidingBlackChoice = z.infer<typeof billiardsDecidingBlackChoiceSchema>;

export const billiardsActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("billiards.shoot"), shot: billiardsShotSchema }),
  z.strictObject({
    type: z.literal("billiards.place-cue"),
    x: z.number().finite().nonnegative().max(4),
    y: z.number().finite().nonnegative().max(2),
  }),
  z.strictObject({
    type: z.literal("billiards.break-choice"),
    choice: billiardsBreakChoiceSchema,
  }),
  z.strictObject({
    type: z.literal("billiards.choose-group"),
    group: billiardsSelectableGroupSchema,
  }),
  z.strictObject({
    type: z.literal("billiards.deciding-black-choice"),
    choice: billiardsDecidingBlackChoiceSchema,
  }),
  z.strictObject({ type: z.literal("billiards.resign") }),
]);
export type BilliardsAction = z.infer<typeof billiardsActionSchema>;
