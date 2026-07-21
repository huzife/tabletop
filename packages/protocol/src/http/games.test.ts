import { describe, expect, it } from "vitest";

import { gameCapabilitiesSummarySchema, gamesResponseSchema } from "./games.js";

describe("game catalog HTTP schema", () => {
  it("defaults the additive solo-practice capability for v1 catalog entries", () => {
    expect(
      gameCapabilitiesSummarySchema.parse({
        bots: false,
        hiddenInformation: false,
        manualSeatReclaim: false,
        midgameJoin: false,
        spectators: true,
        temporaryController: false,
        timers: false,
      }).soloPractice,
    ).toBe(false);
  });

  it("publishes generic bot profiles without game-specific fields", () => {
    const response = gamesResponseSchema.parse({
      games: [
        {
          apiVersion: 1,
          botProfiles: [
            {
              description: "有限时间内搜索合法动作。",
              displayName: "普通",
              profileId: "normal",
              timeBudgetMs: 500,
            },
          ],
          capabilities: {
            bots: true,
            hiddenInformation: false,
            manualSeatReclaim: false,
            midgameJoin: false,
            soloPractice: false,
            spectators: true,
            temporaryController: true,
            timers: true,
          },
          description: "测试游戏",
          displayName: "测试",
          enabled: true,
          gameId: "test-game",
          interactionMode: "turn_based",
          maxPlayers: 2,
          minPlayers: 2,
        },
      ],
    });

    expect(response.games[0]?.botProfiles[0]?.profileId).toBe("normal");
  });
});
