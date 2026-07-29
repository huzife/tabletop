import { z } from "zod";

import { doudizhuCardSchema } from "./cards.js";

const bidActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("doudizhu.bid.call") }),
  z.strictObject({ type: z.literal("doudizhu.bid.rob") }),
  z.strictObject({ type: z.literal("doudizhu.bid.pass") }),
]);

export const doudizhuActionSchema = z.discriminatedUnion("type", [
  ...bidActionSchema.options,
  z.strictObject({ type: z.literal("doudizhu.open-hand"), open: z.boolean() }),
  z.strictObject({ type: z.literal("doudizhu.double"), double: z.boolean() }),
  z.strictObject({
    type: z.literal("doudizhu.play"),
    cardIds: z.array(doudizhuCardSchema.shape.id).min(1).max(20),
  }),
  z.strictObject({ type: z.literal("doudizhu.pass") }),
]);
export type DoudizhuAction = z.infer<typeof doudizhuActionSchema>;
