import { defineGameSharedContractV1 } from "@tabletop/game-sdk";

import { billiardsActionSchema } from "./actions.js";
import { billiardsManifest } from "./manifest.js";
import { billiardsSettings } from "./settings.js";
import { billiardsAimPreviewSchema } from "./transient.js";
import { billiardsDisplayEventSchema, billiardsViewSchema } from "./view.js";

export const billiardsShared = defineGameSharedContractV1({
  actionSchema: billiardsActionSchema,
  displayEventSchema: billiardsDisplayEventSchema,
  manifest: billiardsManifest,
  settings: billiardsSettings,
  transientEventSchema: billiardsAimPreviewSchema,
  viewSchema: billiardsViewSchema,
});
