import { createDefaultSeatDefinitionsV1, type GameLobbyContractV1 } from "@tabletop/game-sdk";
import { defineGameServerModuleV1 } from "@tabletop/game-sdk/server";

import { gomokuShared } from "../shared/contract.js";
import type { GomokuSettings } from "../shared/settings.js";
import { gomokuBotProvider, gomokuFallbackController } from "./ai/provider.js";
import {
  createGomokuMatch,
  getGomokuActiveSeatIds,
  getGomokuDeadlines,
  handleGomokuAction,
  handleGomokuDeadline,
  handleGomokuSystemEvent,
  projectGomokuView,
} from "./engine.js";

const lobby: GameLobbyContractV1<GomokuSettings> = {
  getSeatDefinitions: () => createDefaultSeatDefinitionsV1(2),
  validateStart: (context, settings) => {
    if (context.seats.length !== 2 || context.seats.some(({ occupant }) => occupant === "empty")) {
      return { ok: false, ruleCode: "REQUIRES_TWO_PLAYERS" };
    }
    if (settings.rule === "renju" && context.seats.some(({ occupant }) => occupant === "bot")) {
      return { ok: false, ruleCode: "BOTS_NOT_ALLOWED_IN_RENJU" };
    }
    return { ok: true };
  },
};

export const gomokuServerModule = defineGameServerModuleV1({
  shared: gomokuShared,
  lobby,
  createMatch: createGomokuMatch,
  handleAction: handleGomokuAction,
  projectView: projectGomokuView,
  getDeadlines: getGomokuDeadlines,
  handleDeadline: handleGomokuDeadline,
  handleSystemEvent: handleGomokuSystemEvent,
  getActiveSeatIds: getGomokuActiveSeatIds,
  bot: gomokuBotProvider,
  fallbackController: gomokuFallbackController,
});
