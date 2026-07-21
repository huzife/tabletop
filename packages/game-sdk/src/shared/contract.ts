import type { JsonObject, JsonValue } from "@tabletop/protocol";
import { z } from "zod";

import { defineGameManifestV1, type GameManifestV1 } from "./manifest.js";
import { defineGameSettingsContractV1, type GameSettingsContractV1 } from "./settings.js";

export type GameActionV1 = JsonObject & { readonly type: string };
export type GameDisplayEventV1 = JsonObject & { readonly type: string };
export type GameTransientEventV1 = JsonObject & { readonly type: string };

export interface GameSharedContractV1<
  TSettings extends JsonValue,
  TAction extends GameActionV1,
  TView extends JsonValue,
  TDisplayEvent extends GameDisplayEventV1,
> {
  readonly manifest: GameManifestV1;
  readonly settings: GameSettingsContractV1<TSettings>;
  readonly actionSchema: z.ZodType<TAction>;
  readonly viewSchema: z.ZodType<TView>;
  readonly displayEventSchema: z.ZodType<TDisplayEvent>;
  readonly transientEventSchema?: z.ZodType<GameTransientEventV1>;
}

export function defineGameSharedContractV1<
  TSettings extends JsonValue,
  TAction extends GameActionV1,
  TView extends JsonValue,
  TDisplayEvent extends GameDisplayEventV1,
>(
  contract: GameSharedContractV1<TSettings, TAction, TView, TDisplayEvent>,
): GameSharedContractV1<TSettings, TAction, TView, TDisplayEvent> {
  return Object.freeze({
    ...contract,
    manifest: defineGameManifestV1(contract.manifest),
    settings: defineGameSettingsContractV1(contract.settings),
  });
}
