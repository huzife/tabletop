import { defineGameSettingsContractV1 } from "@tabletop/game-sdk";
import { z } from "zod";

export const gomokuRuleSchema = z.enum(["freestyle", "standard", "renju"]);

export const gomokuSettingsSchema = z.strictObject({
  rule: gomokuRuleSchema,
  timerEnabled: z.boolean(),
  totalTimeMinutes: z.number().int().min(1).max(60),
  moveTimeSeconds: z.number().int().min(5).max(300),
});

export type GomokuRule = z.infer<typeof gomokuRuleSchema>;
export type GomokuSettings = z.infer<typeof gomokuSettingsSchema>;

const RULE_LABELS: Readonly<Record<GomokuRule, string>> = {
  freestyle: "自由规则",
  standard: "标准规则",
  renju: "连珠禁手",
};

export const gomokuSettings = defineGameSettingsContractV1<GomokuSettings>({
  schema: gomokuSettingsSchema,
  defaultValue: {
    rule: "freestyle",
    timerEnabled: false,
    totalTimeMinutes: 10,
    moveTimeSeconds: 60,
  },
  summarize: (settings) => [
    { label: "规则", value: RULE_LABELS[settings.rule] },
    {
      label: "计时",
      value: settings.timerEnabled
        ? `总时 ${settings.totalTimeMinutes} 分钟 / 每步 ${settings.moveTimeSeconds} 秒`
        : "关闭",
    },
  ],
});

export function formatRuleName(rule: GomokuRule): string {
  return RULE_LABELS[rule];
}
