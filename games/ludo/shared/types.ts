import { seatIdSchema, type SeatId } from "@tabletop/game-sdk";
import { z } from "zod";

export const ludoColorSchema = z.enum(["red", "yellow", "green", "blue"]);
export type LudoColor = z.infer<typeof ludoColorSchema>;

export const LUDO_COLORS_CLOCKWISE: readonly LudoColor[] = [
  "red",
  "yellow",
  "green",
  "blue",
] as const;

export const LUDO_SEAT_IDS = {
  blue: seatIdSchema.parse("blue"),
  green: seatIdSchema.parse("green"),
  red: seatIdSchema.parse("red"),
  yellow: seatIdSchema.parse("yellow"),
} as const satisfies Readonly<Record<LudoColor, SeatId>>;

export const ludoPhaseSchema = z.enum([
  "deciding_order",
  "waiting_roll",
  "selecting_plane",
  "resolving",
  "ended",
]);
export type LudoPhase = z.infer<typeof ludoPhaseSchema>;

export const planeIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(red|yellow|green|blue)-plane-[1-4]$/);
export type PlaneId = z.infer<typeof planeIdSchema>;

export const planePositionSchema = z.discriminatedUnion("region", [
  z.strictObject({ region: z.literal("BASE") }),
  z.strictObject({ region: z.literal("APRON") }),
  z.strictObject({ region: z.literal("MAIN_PATH"), pathIndex: z.number().int().min(0).max(49) }),
  z.strictObject({ region: z.literal("HOME_PATH"), pathIndex: z.number().int().min(0).max(4) }),
  z.strictObject({ region: z.literal("FINISHED") }),
]);
export type PlanePosition = z.infer<typeof planePositionSchema>;

export const planeViewSchema = z.strictObject({
  planeId: planeIdSchema,
  color: ludoColorSchema,
  number: z.number().int().min(1).max(4),
  position: planePositionSchema,
  cellId: z.string().min(1).max(64).nullable(),
  selectable: z.boolean(),
});
export type PlaneView = z.infer<typeof planeViewSchema>;

export const controllerKindSchema = z.enum(["human", "bot", "temporary_ai", "persistent_ai"]);
export type ControllerKind = z.infer<typeof controllerKindSchema>;

export const orderRollSchema = z.strictObject({
  round: z.number().int().positive(),
  seatId: seatIdSchema,
  value: z.number().int().min(1).max(6),
});
export type OrderRoll = z.infer<typeof orderRollSchema>;

export const seatViewSchema = z.strictObject({
  seatId: seatIdSchema,
  color: ludoColorSchema,
  controller: controllerKindSchema,
  reclaimable: z.boolean(),
  rank: z.number().int().min(1).max(4).nullable(),
  finishedPlanes: z.number().int().min(0).max(4),
  active: z.boolean(),
});
export type SeatView = z.infer<typeof seatViewSchema>;
