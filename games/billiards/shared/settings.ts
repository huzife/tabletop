import { defineGameSettingsContractV1 } from "@tabletop/game-sdk";
import { z } from "zod";

export const billiardsModeSchema = z.enum(["chinese-eight-ball", "snooker"]);
export type BilliardsMode = z.infer<typeof billiardsModeSchema>;

export const billiardsSettingsSchema = z.strictObject({
  mode: billiardsModeSchema,
});
export type BilliardsSettings = z.infer<typeof billiardsSettingsSchema>;

const MODE_LABELS: Readonly<Record<BilliardsMode, string>> = {
  "chinese-eight-ball": "中式八球",
  snooker: "斯诺克",
};

export const billiardsSettings = defineGameSettingsContractV1<BilliardsSettings>({
  defaultValue: {
    mode: "chinese-eight-ball",
  },
  schema: billiardsSettingsSchema,
  summarize: ({ mode }) => [{ label: "模式", value: MODE_LABELS[mode] }],
});

export function formatBilliardsMode(mode: BilliardsMode): string {
  return MODE_LABELS[mode];
}
