import { z } from "zod";

import { cueTipSchema, MAX_BILLIARDS_SHOT_POWER, MIN_BILLIARDS_SHOT_POWER } from "./actions.js";

export const billiardsAimPreviewSchema = z.strictObject({
  angle: z.number().finite().min(-Math.PI).max(Math.PI),
  elevation: z.number().finite().min(0).max(90),
  power: z.number().finite().min(MIN_BILLIARDS_SHOT_POWER).max(MAX_BILLIARDS_SHOT_POWER),
  shotNumber: z.number().int().nonnegative(),
  tip: cueTipSchema,
  type: z.literal("billiards.aim-preview"),
});

export type BilliardsAimPreview = z.infer<typeof billiardsAimPreviewSchema>;
