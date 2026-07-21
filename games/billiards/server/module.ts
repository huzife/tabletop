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
    validateStart: ({ seats }) => {
      const humanCount = seats.filter(({ occupant }) => occupant === "human").length;
      return seats.length === 2 &&
        seats.every(({ occupant }) => occupant !== "bot") &&
        (humanCount === 1 || humanCount === 2)
        ? { ok: true }
        : { ok: false, ruleCode: "REQUIRES_ONE_OR_TWO_HUMANS" };
    },
  },
  createMatch: createBilliardsMatch,
  handleAction: handleBilliardsAction,
  projectView: projectBilliardsView,
  getDeadlines: getBilliardsDeadlines,
  handleDeadline: handleBilliardsDeadline,
  handleSystemEvent: handleBilliardsSystemEvent,
  getActiveSeatIds: getBilliardsActiveSeatIds,
});
