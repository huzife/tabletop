import { defineGameSettingsContractV1 } from "@tabletop/game-sdk";
import { z } from "zod";

export const billiardsModeSchema = z.enum(["chinese-eight-ball", "snooker"]);
export type BilliardsMode = z.infer<typeof billiardsModeSchema>;

export const DEFAULT_CLOTH_SLIDING_FRICTION = 0.08;
export const DEFAULT_CLOTH_ROLLING_FRICTION = 0.01;
export const CLOTH_SLIDING_FRICTION_RANGE = {
  max: 0.2,
  min: 0.04,
  step: 0.01,
} as const;
export const CLOTH_ROLLING_FRICTION_RANGE = {
  max: 0.02,
  min: 0.003,
  step: 0.001,
} as const;

export const billiardsSettingsSchema = z.strictObject({
  clothRollingFriction: z
    .number()
    .finite()
    .min(CLOTH_ROLLING_FRICTION_RANGE.min)
    .max(CLOTH_ROLLING_FRICTION_RANGE.max)
    .default(DEFAULT_CLOTH_ROLLING_FRICTION),
  clothSlidingFriction: z
    .number()
    .finite()
    .min(CLOTH_SLIDING_FRICTION_RANGE.min)
    .max(CLOTH_SLIDING_FRICTION_RANGE.max)
    .default(DEFAULT_CLOTH_SLIDING_FRICTION),
  mode: billiardsModeSchema,
});
export type BilliardsSettings = z.infer<typeof billiardsSettingsSchema>;

const MODE_LABELS: Readonly<Record<BilliardsMode, string>> = {
  "chinese-eight-ball": "中式八球",
  snooker: "斯诺克",
};

export const billiardsSettings = defineGameSettingsContractV1<BilliardsSettings>({
  defaultValue: {
    clothRollingFriction: DEFAULT_CLOTH_ROLLING_FRICTION,
    clothSlidingFriction: DEFAULT_CLOTH_SLIDING_FRICTION,
    mode: "chinese-eight-ball",
  },
  schema: billiardsSettingsSchema,
  summarize: ({ clothRollingFriction, clothSlidingFriction, mode }) => [
    { label: "模式", value: MODE_LABELS[mode] },
    { label: "滑动摩擦", value: clothSlidingFriction.toFixed(3) },
    { label: "滚动摩擦", value: clothRollingFriction.toFixed(3) },
  ],
});

export function formatBilliardsMode(mode: BilliardsMode): string {
  return MODE_LABELS[mode];
}
