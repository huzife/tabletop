import { defineGameSharedContractV1 } from "@tabletop/game-sdk";

import { templateActionSchema } from "./actions.js";
import { templateManifest } from "./manifest.js";
import { templateSettings } from "./settings.js";
import { templateDisplayEventSchema, templateViewSchema } from "./view.js";

export const templateShared = defineGameSharedContractV1({
  actionSchema: templateActionSchema,
  displayEventSchema: templateDisplayEventSchema,
  manifest: templateManifest,
  settings: templateSettings,
  viewSchema: templateViewSchema,
});
