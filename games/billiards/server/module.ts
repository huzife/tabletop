import { createDefaultSeatDefinitionsV1 } from "@tabletop/game-sdk";
import { defineGameServerModuleV1 } from "@tabletop/game-sdk/server";

import { billiardsShared } from "../shared/contract.js";
import type { BilliardsAction } from "../shared/actions.js";
import type { BilliardsSettings } from "../shared/settings.js";
import type { BilliardsDisplayEvent, BilliardsView } from "../shared/view.js";
import {
  createBilliardsMatch,
  getBilliardsActiveSeatIds,
  getBilliardsDeadlines,
  handleBilliardsAction,
  handleBilliardsDeadline,
  handleBilliardsSystemEvent,
  projectBilliardsView,
} from "./engine.js";
import type { BilliardsMatchState } from "./state.js";

export const billiardsServerModule = defineGameServerModuleV1<
  BilliardsSettings,
  BilliardsMatchState,
  BilliardsAction,
  BilliardsView,
  BilliardsDisplayEvent
>({
  shared: billiardsShared,
  lobby: {
    getSeatDefinitions: () => createDefaultSeatDefinitionsV1(2),
    validateStart: ({ seats }) =>
      seats.length === 2 && seats.every(({ occupant }) => occupant === "human")
        ? { ok: true }
        : { ok: false, ruleCode: "REQUIRES_TWO_PLAYERS" },
  },
  createMatch: createBilliardsMatch,
  handleAction: handleBilliardsAction,
  projectView: projectBilliardsView,
  getDeadlines: getBilliardsDeadlines,
  handleDeadline: handleBilliardsDeadline,
  handleSystemEvent: handleBilliardsSystemEvent,
  getActiveSeatIds: getBilliardsActiveSeatIds,
});
