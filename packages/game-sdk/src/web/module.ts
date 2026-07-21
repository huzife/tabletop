import type { GameId, JsonObject, JsonValue, SeatId } from "@tabletop/protocol";
import type { ComponentType } from "react";

import type {
  GameActionV1,
  GameDisplayEventV1,
  GameSharedContractV1,
  GameTransientEventV1,
} from "../shared/contract.js";
import type { GameManifestV1 } from "../shared/manifest.js";

export type GameConnectionStateV1 = "connected" | "reconnecting" | "offline";

export interface GameSettingsPropsV1<TSettings extends JsonValue> {
  readonly value: TSettings;
  readonly disabled: boolean;
  readonly onChange: (settings: TSettings) => void;
}

export interface ReceivedGameTransientEventV1 {
  readonly event: GameTransientEventV1;
  readonly senderSeatId: SeatId;
  readonly serverTime: string;
}

export interface GameViewPropsV1<
  TView extends JsonValue,
  TAction extends GameActionV1,
  TDisplayEvent extends GameDisplayEventV1,
> {
  readonly view: TView;
  readonly displayEvents: readonly TDisplayEvent[];
  readonly dispatchAction: (action: TAction) => void;
  readonly actionPending: boolean;
  readonly connectionState: GameConnectionStateV1;
  readonly readOnly: boolean;
  readonly transientEvent?: ReceivedGameTransientEventV1 | null;
  readonly dispatchTransientEvent?: (event: GameTransientEventV1) => void;
}

export interface GameWebModuleV1<
  TSettings extends JsonValue,
  TAction extends GameActionV1,
  TView extends JsonValue,
  TDisplayEvent extends GameDisplayEventV1,
> {
  readonly shared: GameSharedContractV1<TSettings, TAction, TView, TDisplayEvent>;
  readonly SettingsEditor?: ComponentType<GameSettingsPropsV1<TSettings>>;
  readonly GameView: ComponentType<GameViewPropsV1<TView, TAction, TDisplayEvent>>;
  formatRuleError?(ruleCode: string, details: JsonObject): string;
}

export function defineGameWebModuleV1<
  TSettings extends JsonValue,
  TAction extends GameActionV1,
  TView extends JsonValue,
  TDisplayEvent extends GameDisplayEventV1,
>(
  module: GameWebModuleV1<TSettings, TAction, TView, TDisplayEvent>,
): GameWebModuleV1<TSettings, TAction, TView, TDisplayEvent> {
  return Object.freeze(module);
}

// Heterogeneous modules are erased only inside the registry; callers recover them by gameId
// and still cross the runtime schemas carried by each module's shared contract.
export type AnyGameWebModuleV1 = GameWebModuleV1<any, any, any, any>;

export class GameWebRegistryV1 {
  readonly #games: ReadonlyMap<GameId, AnyGameWebModuleV1>;

  constructor(modules: readonly AnyGameWebModuleV1[]) {
    const games = new Map<GameId, AnyGameWebModuleV1>();
    for (const module of modules) {
      const { gameId } = module.shared.manifest;
      if (games.has(gameId)) {
        throw new TypeError(`duplicate game id: ${gameId}`);
      }
      games.set(gameId, module);
    }
    this.#games = games;
  }

  get(gameId: GameId): AnyGameWebModuleV1 | undefined {
    return this.#games.get(gameId);
  }

  require(gameId: GameId): AnyGameWebModuleV1 {
    const module = this.get(gameId);
    if (module === undefined) {
      throw new RangeError(`unknown game id: ${gameId}`);
    }
    return module;
  }

  list(): readonly AnyGameWebModuleV1[] {
    return [...this.#games.values()];
  }
}

export function registerWebGamesV1(modules: readonly AnyGameWebModuleV1[]): GameWebRegistryV1 {
  return new GameWebRegistryV1(modules);
}

export function assertManifestCompatibilityV1(
  serverManifests: readonly GameManifestV1[],
  webManifests: readonly GameManifestV1[],
): void {
  const summarize = (manifest: GameManifestV1) =>
    JSON.stringify({
      gameId: manifest.gameId,
      apiVersion: manifest.apiVersion,
      minPlayers: manifest.minPlayers,
      maxPlayers: manifest.maxPlayers,
      interactionMode: manifest.interactionMode,
      capabilities: manifest.capabilities,
    });

  const server = new Map(serverManifests.map((manifest) => [manifest.gameId, summarize(manifest)]));
  const web = new Map(webManifests.map((manifest) => [manifest.gameId, summarize(manifest)]));

  if (server.size !== web.size) {
    throw new TypeError("server and web game registries differ");
  }
  for (const [gameId, summary] of server) {
    if (web.get(gameId) !== summary) {
      throw new TypeError(`server and web manifests differ: ${gameId}`);
    }
  }
}
