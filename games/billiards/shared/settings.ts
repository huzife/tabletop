import { defineGameSettingsContractV1 } from "@tabletop/game-sdk";
import { z } from "zod";

export const billiardsModeSchema = z.enum(["chinese-eight-ball", "snooker"]);
export type BilliardsMode = z.infer<typeof billiardsModeSchema>;

export const BILLIARDS_TABLE_FRICTION_MIN = 0.12;
export const BILLIARDS_TABLE_FRICTION_MAX = 0.28;
export const BILLIARDS_TABLE_FRICTION_STEP = 0.01;
export const BILLIARDS_TABLE_FRICTION_DEFAULT = 0.2;
export const BILLIARDS_SPIN_CONVERGENCE_MIN = 0.5;
export const BILLIARDS_SPIN_CONVERGENCE_MAX = 2;
export const BILLIARDS_SPIN_CONVERGENCE_STEP = 0.1;
export const BILLIARDS_SPIN_CONVERGENCE_DEFAULT = 1;

export const billiardsTableFrictionSchema = z
  .number()
  .finite()
  .min(BILLIARDS_TABLE_FRICTION_MIN)
  .max(BILLIARDS_TABLE_FRICTION_MAX)
  .multipleOf(BILLIARDS_TABLE_FRICTION_STEP)
  .default(BILLIARDS_TABLE_FRICTION_DEFAULT);

export const billiardsSpinConvergenceSchema = z
  .number()
  .finite()
  .min(BILLIARDS_SPIN_CONVERGENCE_MIN)
  .max(BILLIARDS_SPIN_CONVERGENCE_MAX)
  .multipleOf(BILLIARDS_SPIN_CONVERGENCE_STEP)
  .default(BILLIARDS_SPIN_CONVERGENCE_DEFAULT);

export const billiardsSettingsSchema = z.strictObject({
  mode: billiardsModeSchema,
  spinConvergence: billiardsSpinConvergenceSchema,
  tableFriction: billiardsTableFrictionSchema,
});
export type BilliardsSettings = z.infer<typeof billiardsSettingsSchema>;

const MODE_LABELS: Readonly<Record<BilliardsMode, string>> = {
  "chinese-eight-ball": "中式八球",
  snooker: "斯诺克",
};

export const billiardsSettings = defineGameSettingsContractV1<BilliardsSettings>({
  defaultValue: {
    mode: "chinese-eight-ball",
    spinConvergence: BILLIARDS_SPIN_CONVERGENCE_DEFAULT,
    tableFriction: BILLIARDS_TABLE_FRICTION_DEFAULT,
  },
  schema: billiardsSettingsSchema,
  summarize: ({ mode, spinConvergence, tableFriction }) => [
    { label: "模式", value: MODE_LABELS[mode] },
    { label: "台面/边库摩擦", value: formatBilliardsTableFriction(tableFriction) },
    { label: "高低杆收敛", value: formatBilliardsSpinConvergence(spinConvergence) },
  ],
});

export function formatBilliardsMode(mode: BilliardsMode): string {
  return MODE_LABELS[mode];
}

export function formatBilliardsTableFriction(tableFriction: number): string {
  const speed =
    tableFriction < BILLIARDS_TABLE_FRICTION_DEFAULT
      ? "快台"
      : tableFriction > BILLIARDS_TABLE_FRICTION_DEFAULT
        ? "慢台"
        : "标准";
  return `${tableFriction.toFixed(2)}（${speed}）`;
}

export function formatBilliardsSpinConvergence(spinConvergence: number): string {
  const speed =
    spinConvergence < BILLIARDS_SPIN_CONVERGENCE_DEFAULT
      ? "持久"
      : spinConvergence > BILLIARDS_SPIN_CONVERGENCE_DEFAULT
        ? "快速"
        : "标准";
  return `${spinConvergence.toFixed(1)}x（${speed}）`;
}
