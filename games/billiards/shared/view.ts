import { seatIdSchema } from "@tabletop/game-sdk";
import { z } from "zod";

import {
  billiardsBreakChoiceSchema,
  billiardsDecidingBlackChoiceSchema,
  billiardsSelectableGroupSchema,
  billiardsShotSchema,
  snookerColorSchema,
} from "./actions.js";
import { billiardsModeSchema } from "./settings.js";

export const billiardsBallKindSchema = z.enum([
  "cue",
  "solid",
  "stripe",
  "eight",
  "red",
  "yellow",
  "green",
  "brown",
  "blue",
  "pink",
  "black",
]);
export type BilliardsBallKind = z.infer<typeof billiardsBallKindSchema>;

export const billiardsBallSchema = z.strictObject({
  id: z.string().min(1).max(24),
  kind: billiardsBallKindSchema,
  number: z.number().int().min(1).max(15).nullable(),
  pocketed: z.boolean(),
  rotation: z.number().finite(),
  value: z.number().int().min(0).max(8),
  x: z.number().finite().min(-1).max(5),
  y: z.number().finite().min(-1).max(3),
});
export type BilliardsBall = z.infer<typeof billiardsBallSchema>;

export const eightBallGroupSchema = z.enum(["open", "solids", "stripes"]);
export type EightBallGroup = z.infer<typeof eightBallGroupSchema>;

const playerSchema = z.strictObject({
  active: z.boolean(),
  group: eightBallGroupSchema.nullable(),
  score: z.number().int().nonnegative(),
  seatId: seatIdSchema,
});

const tableViewSchema = z.strictObject({
  ballDiameter: z.number().finite().positive(),
  ballMass: z.number().finite().positive(),
  baulkLineX: z.number().finite().nonnegative().nullable(),
  circularCushions: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(16),
        radius: z.number().finite().positive(),
        x: z.number().finite(),
        y: z.number().finite(),
      }),
    )
    .length(12),
  cushionWidth: z.number().finite().positive(),
  dRadius: z.number().finite().positive().nullable(),
  height: z.number().finite().positive(),
  linearCushions: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(16),
        x1: z.number().finite(),
        x2: z.number().finite(),
        y1: z.number().finite(),
        y2: z.number().finite(),
      }),
    )
    .length(18),
  mode: billiardsModeSchema,
  outerHeight: z.number().finite().positive(),
  outerWidth: z.number().finite().positive(),
  pockets: z
    .array(
      z.strictObject({
        captureX: z.number().finite(),
        captureY: z.number().finite(),
        captureRadius: z.number().finite().positive(),
        id: z.string().min(1).max(16),
        kind: z.enum(["corner", "side"]),
        mouthWidth: z.number().finite().positive(),
        x: z.number().finite(),
        y: z.number().finite(),
      }),
    )
    .length(6),
  spots: z.array(
    z.strictObject({
      id: z.string().min(1).max(16),
      x: z.number().finite().nonnegative(),
      y: z.number().finite().nonnegative(),
    }),
  ),
  width: z.number().finite().positive(),
});

export const snookerOnSchema = z.enum([
  "red",
  "color",
  "yellow",
  "green",
  "brown",
  "blue",
  "pink",
  "black",
]);
export type SnookerOn = z.infer<typeof snookerOnSchema>;

const lastShotSchema = z
  .strictObject({
    foulCode: z.string().min(1).max(64).nullable(),
    points: z.number().int().min(0).max(64),
    pottedBallIds: z.array(z.string().min(1).max(24)),
    seatId: seatIdSchema,
  })
  .nullable();

const outcomeSchema = z
  .strictObject({
    reason: z.enum(["eight-ball", "final-black", "resigned", "disconnected", "left"]),
    winnerSeatId: seatIdSchema,
  })
  .nullable();

export const billiardsPendingDecisionSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("break-choice"),
      reason: z.enum(["illegal-break", "break-foul", "eight-on-break", "eight-on-break-foul"]),
      breakerSeatId: seatIdSchema,
      chooserSeatId: seatIdSchema,
      choices: z.array(billiardsBreakChoiceSchema).min(2).max(3).readonly(),
    }),
    z.strictObject({
      type: z.literal("choose-group"),
      chooserSeatId: seatIdSchema,
      groups: z.array(billiardsSelectableGroupSchema).length(2).readonly(),
    }),
    z.strictObject({
      type: z.literal("deciding-black-choice"),
      chooserSeatId: seatIdSchema,
      choices: z.array(billiardsDecidingBlackChoiceSchema).length(2).readonly(),
    }),
  ])
  .nullable();
export type BilliardsPendingDecisionView = z.infer<typeof billiardsPendingDecisionSchema>;

export const billiardsViewSchema = z.strictObject({
  activeSeatId: seatIdSchema.nullable(),
  ballInHandZone: z.enum(["anywhere", "behind-line", "d"]).nullable(),
  balls: z.array(billiardsBallSchema).min(16).max(22),
  breakShot: z.boolean(),
  legalActions: z.strictObject({
    canChooseDecidingBlack: z.boolean(),
    canChooseGroup: z.boolean(),
    canPlaceCue: z.boolean(),
    canResign: z.boolean(),
    canResolveBreak: z.boolean(),
    canShoot: z.boolean(),
  }),
  lastShot: lastShotSchema,
  mode: billiardsModeSchema,
  outcome: outcomeSchema,
  pendingDecision: billiardsPendingDecisionSchema,
  phase: z.enum(["aiming", "ball_in_hand", "decision", "ended"]),
  players: z.array(playerSchema).min(1).max(2),
  practice: z.boolean(),
  shotNumber: z.number().int().nonnegative(),
  snookerOn: snookerOnSchema.nullable(),
  table: tableViewSchema,
  viewerSeatId: seatIdSchema.nullable(),
});
export type BilliardsView = z.infer<typeof billiardsViewSchema>;

const shotDisplayEventSchema = z.strictObject({
  durationMs: z.number().int().nonnegative().max(300_000),
  foulCode: z.string().min(1).max(64).nullable(),
  initialBalls: z.array(billiardsBallSchema).min(16).max(22),
  mode: billiardsModeSchema,
  nextSeatId: seatIdSchema.nullable(),
  points: z.number().int().min(0).max(64),
  pottedBallIds: z.array(z.string().min(1).max(24)),
  physicsVersion: z.string().min(1).max(64).nullable().default(null),
  seatId: seatIdSchema,
  shot: billiardsShotSchema,
  shotNumber: z.number().int().positive(),
  simulationChecksum: z.string().regex(/^[a-f0-9]{8}$/),
  simulationStateHash: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .nullable()
    .default(null),
  type: z.literal("billiards.shot"),
});

const matchEndedDisplayEventSchema = z.strictObject({
  reason: z.enum(["eight-ball", "final-black", "resigned", "disconnected", "left"]),
  type: z.literal("billiards.match-ended"),
  winnerSeatId: seatIdSchema,
});

export const billiardsDisplayEventSchema = z.preprocess(
  (input) => {
    if (
      typeof input !== "object" ||
      input === null ||
      !("type" in input) ||
      input.type !== "billiards.shot"
    ) {
      return input;
    }
    const event = { ...input } as Record<string, unknown>;
    // Old display events remain readable, but removed room-tuning fields do
    // not survive parsing into the current contract.
    delete event.spinConvergence;
    delete event.tableFriction;
    return event;
  },
  z.discriminatedUnion("type", [shotDisplayEventSchema, matchEndedDisplayEventSchema]),
);
export type BilliardsDisplayEvent = z.infer<typeof billiardsDisplayEventSchema>;

export type BilliardsShotDisplayEvent = Extract<
  BilliardsDisplayEvent,
  { readonly type: "billiards.shot" }
>;

export const snookerNominationSchema = snookerColorSchema.nullable();
