import { defineGameSharedContractV1 } from "@tabletop/game-sdk";

import { gomokuActionSchema } from "./actions.js";
import { gomokuManifest } from "./manifest.js";
import { gomokuSettings } from "./settings.js";
import { gomokuDisplayEventSchema, gomokuViewSchema } from "./view.js";

export const gomokuShared = defineGameSharedContractV1({
  manifest: gomokuManifest,
  settings: gomokuSettings,
  actionSchema: gomokuActionSchema,
  viewSchema: gomokuViewSchema,
  displayEventSchema: gomokuDisplayEventSchema,
});
