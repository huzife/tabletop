import type { JsonValue, SeatId } from "@tabletop/protocol";
import { z } from "zod";

import type { GameActionV1, GameDisplayEventV1, GameSharedContractV1 } from "../shared/contract.js";
import { gameSeatDefinitionV1Schema, type GameLobbyContractV1 } from "../shared/lobby.js";
import type { GameBotProviderV1, GameFallbackControllerV1 } from "./automation.js";
import { validateBotProfilesV1 } from "./automation.js";
import type {
  ActionContextV1,
  CreateMatchContextV1,
  DeadlineContextV1,
  ProjectionContextV1,
  SystemEventContextV1,
  ViewerV1,
} from "./context.js";
import type { GameDeadlineV1, GameSystemEventV1, GameTransitionV1 } from "./lifecycle.js";

export interface GameServerModuleV1<
  TSettings extends JsonValue,
  TState extends object,
  TAction extends GameActionV1,
  TView extends JsonValue,
  TDisplayEvent extends GameDisplayEventV1,
  TBotInput extends JsonValue = JsonValue,
  TFallbackInput extends JsonValue = JsonValue,
> {
  readonly shared: GameSharedContractV1<TSettings, TAction, TView, TDisplayEvent>;
  readonly lobby?: GameLobbyContractV1<TSettings>;
  createMatch(context: CreateMatchContextV1, settings: Readonly<TSettings>): TState;
  handleAction(
    context: ActionContextV1,
    state: Readonly<TState>,
    action: TAction,
  ): GameTransitionV1<TState, TDisplayEvent>;
  projectView(context: ProjectionContextV1, state: Readonly<TState>, viewer: ViewerV1): TView;
  getDeadlines(state: Readonly<TState>): readonly GameDeadlineV1[];
  handleDeadline(
    context: DeadlineContextV1,
    state: Readonly<TState>,
    deadline: GameDeadlineV1,
  ): GameTransitionV1<TState, TDisplayEvent>;
  handleSystemEvent(
    context: SystemEventContextV1,
    state: Readonly<TState>,
    event: GameSystemEventV1,
  ): GameTransitionV1<TState, TDisplayEvent>;
  getActiveSeatIds?(state: Readonly<TState>): readonly SeatId[];
  readonly bot?: GameBotProviderV1<TState, TAction, TBotInput>;
  readonly fallbackController?: GameFallbackControllerV1<TState, TAction, TFallbackInput>;
}

export function defineGameServerModuleV1<
  TSettings extends JsonValue,
  TState extends object,
  TAction extends GameActionV1,
  TView extends JsonValue,
  TDisplayEvent extends GameDisplayEventV1,
  TBotInput extends JsonValue = JsonValue,
  TFallbackInput extends JsonValue = JsonValue,
>(
  module: GameServerModuleV1<
    TSettings,
    TState,
    TAction,
    TView,
    TDisplayEvent,
    TBotInput,
    TFallbackInput
  >,
): GameServerModuleV1<TSettings, TState, TAction, TView, TDisplayEvent, TBotInput, TFallbackInput> {
  const { capabilities } = module.shared.manifest;
  if (capabilities.bots !== (module.bot !== undefined)) {
    throw new TypeError("bots capability and bot provider must match");
  }
  if (capabilities.temporaryController !== (module.fallbackController !== undefined)) {
    throw new TypeError("temporaryController capability and fallback controller must match");
  }

  if (module.bot !== undefined) {
    validateBotProfilesV1(module.bot.listProfiles());
  }

  if (module.lobby !== undefined) {
    const seats = z
      .array(gameSeatDefinitionV1Schema)
      .parse(module.lobby.getSeatDefinitions(module.shared.settings.defaultValue));
    const ids = new Set(seats.map(({ seatId }) => seatId));
    if (ids.size !== seats.length) {
      throw new TypeError("lobby returned duplicate seat ids");
    }
    if (
      seats.length < module.shared.manifest.minPlayers ||
      seats.length > module.shared.manifest.maxPlayers
    ) {
      throw new TypeError("lobby seat count is outside manifest limits");
    }
  }

  return Object.freeze(module);
}
