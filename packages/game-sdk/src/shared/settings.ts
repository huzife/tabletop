import type { JsonValue } from "@tabletop/protocol";
import { z } from "zod";

export const gameSettingsSummaryItemV1Schema = z.strictObject({
  label: z.string().min(1).max(80),
  value: z.string().max(160),
});

export interface GameSettingsContractV1<TSettings extends JsonValue> {
  readonly schema: z.ZodType<TSettings>;
  readonly defaultValue: TSettings;
  summarize(settings: Readonly<TSettings>): readonly GameSettingsSummaryItemV1[];
}

export function defineGameSettingsContractV1<TSettings extends JsonValue>(
  contract: GameSettingsContractV1<TSettings>,
): GameSettingsContractV1<TSettings> {
  const defaultValue = contract.schema.parse(contract.defaultValue);
  const summary = contract.summarize(defaultValue);
  z.array(gameSettingsSummaryItemV1Schema).parse(summary);

  return Object.freeze({
    ...contract,
    defaultValue,
  });
}

export type GameSettingsSummaryItemV1 = z.infer<typeof gameSettingsSummaryItemV1Schema>;
