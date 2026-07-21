import { gameIdSchema } from "@tabletop/protocol";
import { z } from "zod";

export const GAME_SDK_API_VERSION = 1 as const;

export const interactionModeSchema = z.enum(["turn_based", "simultaneous", "realtime"]);

export const gameCapabilitiesV1Schema = z.strictObject({
  spectators: z.boolean(),
  midgameJoin: z.boolean(),
  timers: z.boolean(),
  hiddenInformation: z.boolean(),
  bots: z.boolean(),
  soloPractice: z.boolean().default(false),
  temporaryController: z.boolean(),
  manualSeatReclaim: z.boolean(),
});

export const gameManifestV1Schema = z
  .strictObject({
    apiVersion: z.literal(GAME_SDK_API_VERSION),
    gameId: gameIdSchema,
    displayName: z.string().min(1).max(80),
    description: z.string().max(500),
    minPlayers: z.number().int().positive(),
    maxPlayers: z.number().int().positive(),
    interactionMode: interactionModeSchema,
    capabilities: gameCapabilitiesV1Schema,
  })
  .refine((manifest) => manifest.minPlayers <= manifest.maxPlayers, {
    message: "minPlayers must not exceed maxPlayers",
    path: ["minPlayers"],
  });

export function defineGameManifestV1(
  manifest: z.input<typeof gameManifestV1Schema>,
): GameManifestV1 {
  return Object.freeze(gameManifestV1Schema.parse(manifest));
}

export type GameCapabilitiesV1 = z.infer<typeof gameCapabilitiesV1Schema>;
export type GameManifestV1 = z.infer<typeof gameManifestV1Schema>;
export type InteractionMode = z.infer<typeof interactionModeSchema>;
