import {
  jsonObjectSchema,
  seatIdSchema,
  type JsonObject,
  type JsonValue,
} from "@tabletop/protocol";
import { z } from "zod";

export const gameSeatDefinitionV1Schema = z.strictObject({
  seatId: seatIdSchema,
  displayName: z.string().min(1).max(64),
});

export const gameLobbySeatV1Schema = z.strictObject({
  seatId: seatIdSchema,
  occupant: z.enum(["empty", "human", "bot"]),
  ready: z.boolean(),
});

export const gameStartValidationV1Schema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    ruleCode: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[A-Z][A-Z0-9_]*$/),
    publicDetails: jsonObjectSchema.optional(),
  }),
]);

export interface GameStartContextV1 {
  readonly seats: readonly GameLobbySeatV1[];
}

export interface GameLobbyContractV1<TSettings extends JsonValue> {
  getSeatDefinitions(settings: Readonly<TSettings>): readonly GameSeatDefinitionV1[];
  validateStart(context: GameStartContextV1, settings: Readonly<TSettings>): GameStartValidationV1;
}

export function createDefaultSeatDefinitionsV1(
  playerCount: number,
): readonly GameSeatDefinitionV1[] {
  if (!Number.isSafeInteger(playerCount) || playerCount <= 0) {
    throw new RangeError("playerCount must be a positive safe integer");
  }

  return Array.from({ length: playerCount }, (_, index) => ({
    seatId: seatIdSchema.parse(`seat-${index + 1}`),
    displayName: `座位 ${index + 1}`,
  }));
}

export type GameLobbySeatV1 = z.infer<typeof gameLobbySeatV1Schema>;
export type GameSeatDefinitionV1 = z.infer<typeof gameSeatDefinitionV1Schema>;
export type GameStartValidationV1 =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly ruleCode: string;
      readonly publicDetails?: JsonObject;
    };
