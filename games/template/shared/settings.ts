import { defineGameSettingsContractV1 } from "@tabletop/game-sdk";
import { z } from "zod";

export const templateSettingsSchema = z.strictObject({
  targetScore: z.number().int().min(1).max(20),
});

export type TemplateSettings = z.infer<typeof templateSettingsSchema>;

export const templateSettings = defineGameSettingsContractV1<TemplateSettings>({
  defaultValue: { targetScore: 3 },
  schema: templateSettingsSchema,
  summarize: ({ targetScore }) => [{ label: "获胜分数", value: String(targetScore) }],
});
