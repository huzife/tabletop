import { z } from "zod";

import { cueTipSchema } from "./actions.js";

export const billiardsAimPreviewSchema = z.strictObject({
  angle: z.number().finite().min(-Math.PI).max(Math.PI),
  elevation: z.number().finite().min(0).max(90),
  power: z.number().finite().min(1).max(100),
  shotNumber: z.number().int().nonnegative(),
  tip: cueTipSchema,
  type: z.literal("billiards.aim-preview"),
});

export type BilliardsAimPreview = z.infer<typeof billiardsAimPreviewSchema>;
