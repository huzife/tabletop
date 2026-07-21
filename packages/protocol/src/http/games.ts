import { z } from "zod";

import { gameIdSchema } from "../ids.js";

export const interactionModeSchema = z.enum(["turn_based", "simultaneous", "realtime"]);

export const gameCapabilitiesSummarySchema = z.strictObject({
  spectators: z.boolean(),
  midgameJoin: z.boolean(),
  timers: z.boolean(),
  hiddenInformation: z.boolean(),
  bots: z.boolean(),
  soloPractice: z.boolean().default(false),
  temporaryController: z.boolean(),
  manualSeatReclaim: z.boolean(),
});

export const botProfileSummarySchema = z.strictObject({
  profileId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(64),
  description: z.string().max(240),
  timeBudgetMs: z.number().int().positive().safe(),
});

export const gameCatalogEntrySchema = z
  .strictObject({
    apiVersion: z.literal(1),
    gameId: gameIdSchema,
    displayName: z.string().min(1).max(80),
    description: z.string().max(500),
    minPlayers: z.number().int().positive(),
    maxPlayers: z.number().int().positive(),
    interactionMode: interactionModeSchema,
    capabilities: gameCapabilitiesSummarySchema,
    botProfiles: z.array(botProfileSummarySchema),
    enabled: z.boolean(),
  })
  .refine((value) => value.minPlayers <= value.maxPlayers, {
    message: "minPlayers must not exceed maxPlayers",
    path: ["minPlayers"],
  });

export const gamesResponseSchema = z.strictObject({
  games: z.array(gameCatalogEntrySchema),
});

export type GameCapabilitiesSummary = z.infer<typeof gameCapabilitiesSummarySchema>;
export type BotProfileSummary = z.infer<typeof botProfileSummarySchema>;
export type GameCatalogEntry = z.infer<typeof gameCatalogEntrySchema>;
export type GamesResponse = z.infer<typeof gamesResponseSchema>;
export type InteractionMode = z.infer<typeof interactionModeSchema>;
