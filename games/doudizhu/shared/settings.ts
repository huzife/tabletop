import { defineGameSettingsContractV1 } from "@tabletop/game-sdk";
import { z } from "zod";

export const doudizhuSettingsSchema = z.strictObject({
  variant: z.literal("rob-landlord"),
});
export type DoudizhuSettings = z.infer<typeof doudizhuSettingsSchema>;

export const doudizhuSettings = defineGameSettingsContractV1<DoudizhuSettings>({
  defaultValue: { variant: "rob-landlord" },
  schema: doudizhuSettingsSchema,
  summarize: () => [{ label: "玩法", value: "经典抢地主" }],
});
