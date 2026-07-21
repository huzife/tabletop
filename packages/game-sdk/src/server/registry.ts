import type { GameId, JsonValue, SeatId } from "@tabletop/protocol";

import type { GameActionV1, GameDisplayEventV1, GameTransientEventV1 } from "../shared/contract.js";
import type {
  GameLobbySeatV1,
  GameSeatDefinitionV1,
  GameStartValidationV1,
} from "../shared/lobby.js";
import { createDefaultSeatDefinitionsV1 } from "../shared/lobby.js";
import type { GameManifestV1, InteractionMode } from "../shared/manifest.js";
import type { AutomatedActionRequestV1, BotProfileV1 } from "./automation.js";
import type {
  ActionContextV1,
  AutomationInputContextV1,
  CreateMatchContextV1,
  DeadlineContextV1,
  ProjectionContextV1,
  SystemEventContextV1,
  ViewerV1,
} from "./context.js";
import {
  gameDeadlineV1Schema,
  gameOutcomeV1Schema,
  gameRoomDirectiveV1Schema,
  gameSystemEventV1Schema,
  type GameDeadlineV1,
  type GameTransitionV1,
} from "./lifecycle.js";
import type { GameServerModuleV1 } from "./module.js";

export type AnyGameServerModuleV1 = GameServerModuleV1<
  JsonValue,
  object,
  GameActionV1,
  JsonValue,
  GameDisplayEventV1,
  JsonValue,
  JsonValue
>;

export type HostedGameTransitionV1 = GameTransitionV1<object, GameDisplayEventV1>;

export interface HostedGameServerModuleV1 {
  readonly manifest: GameManifestV1;
  parseSettings(input: unknown): JsonValue;
  summarizeSettings(settings: JsonValue): readonly {
    readonly label: string;
    readonly value: string;
  }[];
  createMatch(context: CreateMatchContextV1, settings: JsonValue): object;
  handleAction(
    context: ActionContextV1,
    state: Readonly<object>,
    input: unknown,
  ): HostedGameTransitionV1;
  projectView(context: ProjectionContextV1, state: Readonly<object>, viewer: ViewerV1): JsonValue;
  getDeadlines(state: Readonly<object>): readonly GameDeadlineV1[];
  handleDeadline(
    context: DeadlineContextV1,
    state: Readonly<object>,
    deadline: GameDeadlineV1,
  ): HostedGameTransitionV1;
  handleSystemEvent(
    context: SystemEventContextV1,
    state: Readonly<object>,
    event: unknown,
  ): HostedGameTransitionV1;
  getSeatDefinitions(settings: JsonValue): readonly GameSeatDefinitionV1[];
  validateStart(settings: JsonValue, seats: readonly GameLobbySeatV1[]): GameStartValidationV1;
  getActiveSeatIds(state: Readonly<object>): readonly SeatId[];
  parseTransientEvent(input: unknown): GameTransientEventV1 | null;
  listBotProfiles(): readonly BotProfileV1[];
  createBotInput(
    context: AutomationInputContextV1,
    state: Readonly<object>,
    seatId: SeatId,
  ): JsonValue;
  chooseBotAction(
    request: AutomatedActionRequestV1<JsonValue> & { readonly profileId: string },
  ): Promise<GameActionV1>;
  createFallbackInput(
    context: AutomationInputContextV1,
    state: Readonly<object>,
    seatId: SeatId,
  ): JsonValue;
  chooseFallbackAction(
    request: AutomatedActionRequestV1<JsonValue>,
    reason: "disconnect" | "timeout",
  ): Promise<GameActionV1>;
}

function normalizeTransition(
  module: AnyGameServerModuleV1,
  transition: HostedGameTransitionV1,
): HostedGameTransitionV1 {
  if (transition.kind === "noop") {
    return transition;
  }

  return {
    kind: "applied",
    state: transition.state,
    events: transition.events.map((event) => module.shared.displayEventSchema.parse(event)),
    ...(transition.outcome === undefined
      ? {}
      : { outcome: gameOutcomeV1Schema.parse(transition.outcome) }),
    ...(transition.roomDirectives === undefined
      ? {}
      : {
          roomDirectives: transition.roomDirectives.map((directive) =>
            gameRoomDirectiveV1Schema.parse(directive),
          ),
        }),
  };
}

export function createHostedGameServerModuleV1(
  module: AnyGameServerModuleV1,
): HostedGameServerModuleV1 {
  const hosted: HostedGameServerModuleV1 = {
    manifest: module.shared.manifest,
    parseSettings(input) {
      return module.shared.settings.schema.parse(input);
    },
    summarizeSettings(settings) {
      return module.shared.settings.summarize(module.shared.settings.schema.parse(settings));
    },
    createMatch(context, settings) {
      return module.createMatch(context, module.shared.settings.schema.parse(settings));
    },
    handleAction(context, state, input) {
      return normalizeTransition(
        module,
        module.handleAction(context, state, module.shared.actionSchema.parse(input)),
      );
    },
    projectView(context, state, viewer) {
      return module.shared.viewSchema.parse(module.projectView(context, state, viewer));
    },
    getDeadlines(state) {
      return module.getDeadlines(state).map((deadline) => gameDeadlineV1Schema.parse(deadline));
    },
    handleDeadline(context, state, deadline) {
      const parsed = gameDeadlineV1Schema.parse(deadline);
      return normalizeTransition(module, module.handleDeadline(context, state, parsed));
    },
    handleSystemEvent(context, state, event) {
      const parsed = gameSystemEventV1Schema.parse(event);
      return normalizeTransition(module, module.handleSystemEvent(context, state, parsed));
    },
    getSeatDefinitions(settings) {
      const parsedSettings = module.shared.settings.schema.parse(settings);
      return (
        module.lobby?.getSeatDefinitions(parsedSettings) ??
        createDefaultSeatDefinitionsV1(module.shared.manifest.maxPlayers)
      );
    },
    validateStart(settings, seats) {
      const parsedSettings = module.shared.settings.schema.parse(settings);
      return module.lobby?.validateStart({ seats }, parsedSettings) ?? { ok: true };
    },
    getActiveSeatIds(state) {
      return module.getActiveSeatIds?.(state) ?? [];
    },
    parseTransientEvent(input) {
      return module.shared.transientEventSchema?.parse(input) ?? null;
    },
    listBotProfiles() {
      return module.bot?.listProfiles() ?? [];
    },
    createBotInput(context, state, seatId) {
      if (module.bot === undefined) {
        throw new TypeError("game does not provide a bot controller");
      }
      return module.bot.inputSchema.parse(module.bot.createInput(context, state, seatId));
    },
    async chooseBotAction(request) {
      if (module.bot === undefined) {
        throw new TypeError("game does not provide a bot controller");
      }
      return module.shared.actionSchema.parse(await module.bot.chooseAction(request));
    },
    createFallbackInput(context, state, seatId) {
      if (module.fallbackController === undefined) {
        throw new TypeError("game does not provide a fallback controller");
      }
      return module.fallbackController.inputSchema.parse(
        module.fallbackController.createInput(context, state, seatId),
      );
    },
    async chooseFallbackAction(request, reason) {
      if (module.fallbackController === undefined) {
        throw new TypeError("game does not provide a fallback controller");
      }
      return module.shared.actionSchema.parse(
        await module.fallbackController.chooseFallbackAction(request, reason),
      );
    },
  };
  return Object.freeze(hosted);
}

export class GameServerRegistryV1 {
  readonly #games: ReadonlyMap<GameId, HostedGameServerModuleV1>;

  constructor(
    modules: readonly AnyGameServerModuleV1[],
    supportedInteractionModes: readonly InteractionMode[] = ["turn_based"],
  ) {
    const supported = new Set(supportedInteractionModes);
    const games = new Map<GameId, HostedGameServerModuleV1>();

    for (const module of modules) {
      const { gameId, interactionMode } = module.shared.manifest;
      if (!supported.has(interactionMode)) {
        throw new TypeError(`unsupported interaction mode: ${interactionMode}`);
      }
      if (games.has(gameId)) {
        throw new TypeError(`duplicate game id: ${gameId}`);
      }
      games.set(gameId, createHostedGameServerModuleV1(module));
    }

    this.#games = games;
  }

  get(gameId: GameId): HostedGameServerModuleV1 | undefined {
    return this.#games.get(gameId);
  }

  require(gameId: GameId): HostedGameServerModuleV1 {
    const module = this.get(gameId);
    if (module === undefined) {
      throw new RangeError(`unknown game id: ${gameId}`);
    }
    return module;
  }

  list(): readonly HostedGameServerModuleV1[] {
    return [...this.#games.values()];
  }
}

export function registerServerGamesV1(
  modules: readonly AnyGameServerModuleV1[],
  supportedInteractionModes?: readonly InteractionMode[],
): GameServerRegistryV1 {
  return new GameServerRegistryV1(modules, supportedInteractionModes);
}
