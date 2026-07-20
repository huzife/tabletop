import { defineGameSharedContractV1, gameIdSchema, seatIdSchema } from "@tabletop/game-sdk";
import { z } from "zod";

import { boardPresentationSchema, LUDO_BOARD_PRESENTATION } from "./board.js";
import {
  controllerKindSchema,
  ludoPhaseSchema,
  orderRollSchema,
  planeIdSchema,
  planeViewSchema,
  seatViewSchema,
} from "./types.js";

export const ludoSettingsSchema = z.strictObject({
  phaseTimeSeconds: z.number().int().min(10).max(120),
});
export type LudoSettings = z.infer<typeof ludoSettingsSchema>;

export const ludoActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("roll") }),
  z.strictObject({ type: z.literal("select_plane"), planeId: planeIdSchema }),
]);
export type LudoAction = z.infer<typeof ludoActionSchema>;

const cellIdSchema = z.string().min(1).max(64);

export const ludoDisplayStepSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("roll"),
    seatId: seatIdSchema,
    value: z.number().int().min(1).max(6),
    purpose: z.enum(["order", "turn"]),
    round: z.number().int().positive().nullable(),
  }),
  z.strictObject({
    type: z.literal("launch"),
    planeId: planeIdSchema,
    fromCellId: cellIdSchema,
    toCellId: cellIdSchema,
  }),
  z.strictObject({
    type: z.literal("move"),
    planeId: planeIdSchema,
    fromCellId: cellIdSchema,
    toCellId: cellIdSchema,
    direction: z.enum(["forward", "backward"]),
  }),
  z.strictObject({
    type: z.literal("bounce"),
    planeId: planeIdSchema,
    atCellId: cellIdSchema,
    reason: z.enum(["blockade", "finish", "apron"]),
  }),
  z.strictObject({
    type: z.literal("capture"),
    planeId: planeIdSchema,
    atCellId: cellIdSchema,
    capturedPlaneIds: z.array(planeIdSchema),
    mutual: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("jump_cancelled"),
    planeId: planeIdSchema,
    fromCellId: cellIdSchema,
    blockedCellId: cellIdSchema,
  }),
  z.strictObject({
    type: z.literal("jump"),
    planeId: planeIdSchema,
    fromCellId: cellIdSchema,
    toCellId: cellIdSchema,
  }),
  z.strictObject({
    type: z.literal("fly"),
    planeId: planeIdSchema,
    fromCellId: cellIdSchema,
    toCellId: cellIdSchema,
  }),
  z.strictObject({ type: z.literal("finish"), planeId: planeIdSchema, atCellId: cellIdSchema }),
  z.strictObject({
    type: z.literal("three_sixes"),
    seatId: seatIdSchema,
    returnedPlaneIds: z.array(planeIdSchema),
  }),
  z.strictObject({
    type: z.literal("rank"),
    seatId: seatIdSchema,
    rank: z.number().int().min(1).max(4),
  }),
  z.strictObject({ type: z.literal("turn"), seatId: seatIdSchema }),
]);
export type LudoDisplayStep = z.infer<typeof ludoDisplayStepSchema>;

export const ludoViewSchema = z.strictObject({
  phase: ludoPhaseSchema,
  board: boardPresentationSchema,
  seats: z.array(seatViewSchema),
  planes: z.array(planeViewSchema),
  seatOrder: z.array(seatIdSchema),
  currentSeatId: seatIdSchema.nullable(),
  sixStreak: z.number().int().min(0).max(2),
  roll: z.number().int().min(1).max(6).nullable(),
  rankings: z.array(seatIdSchema),
  orderRolls: z.array(orderRollSchema),
  legalPlaneIds: z.array(planeIdSchema),
  canRoll: z.boolean(),
  canSelectPlane: z.boolean(),
  deadlineRemainingMs: z.number().nonnegative().finite().nullable(),
  phaseTimeSeconds: z.number().int().min(10).max(120),
  viewerSeatId: seatIdSchema.nullable(),
  viewerController: controllerKindSchema.nullable(),
  lastSteps: z.array(ludoDisplayStepSchema),
});
export type LudoView = z.infer<typeof ludoViewSchema>;

export const ludoShared = defineGameSharedContractV1({
  manifest: {
    apiVersion: 1,
    gameId: gameIdSchema.parse("ludo"),
    displayName: "飞行棋",
    description: "支持 2 至 4 人、AI 补位、叠机反弹与快捷飞行的中国飞行棋。",
    minPlayers: 2,
    maxPlayers: 4,
    interactionMode: "turn_based",
    capabilities: {
      spectators: true,
      midgameJoin: false,
      timers: true,
      hiddenInformation: false,
      bots: true,
      temporaryController: true,
      manualSeatReclaim: true,
    },
  },
  settings: {
    schema: ludoSettingsSchema,
    defaultValue: { phaseTimeSeconds: 30 },
    summarize: ({ phaseTimeSeconds }) => [{ label: "阶段时间", value: `${phaseTimeSeconds} 秒` }],
  },
  actionSchema: ludoActionSchema,
  viewSchema: ludoViewSchema,
  displayEventSchema: ludoDisplayStepSchema,
});

export { LUDO_BOARD_PRESENTATION };
