import type { JsonValue } from "@tabletop/protocol";

import type { AnyGameServerModuleV1 } from "../server/registry.js";
import {
  createHostedGameServerModuleV1,
  type HostedGameServerModuleV1,
} from "../server/registry.js";

export interface GameContractHarnessV1 {
  readonly hosted: HostedGameServerModuleV1;
  readonly defaultSettings: JsonValue;
}

export function createGameContractHarnessV1(module: AnyGameServerModuleV1): GameContractHarnessV1 {
  return {
    hosted: createHostedGameServerModuleV1(module),
    defaultSettings: module.shared.settings.schema.parse(module.shared.settings.defaultValue),
  };
}

export function deepFreezeV1<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreezeV1(nested);
    }
  }
  return value;
}
