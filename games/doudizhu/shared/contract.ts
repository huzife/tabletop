import { defineGameSharedContractV1 } from "@tabletop/game-sdk";

import { doudizhuActionSchema } from "./actions.js";
import { doudizhuManifest } from "./manifest.js";
import { doudizhuSettings } from "./settings.js";
import { doudizhuDisplayEventSchema, doudizhuViewSchema } from "./view.js";

export const doudizhuShared = defineGameSharedContractV1({
  actionSchema: doudizhuActionSchema,
  displayEventSchema: doudizhuDisplayEventSchema,
  manifest: doudizhuManifest,
  settings: doudizhuSettings,
  viewSchema: doudizhuViewSchema,
});
