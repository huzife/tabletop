import { defineGameManifestV1 } from "@tabletop/game-sdk";

// Replace this stable id before registering a copied plugin.
export const templateManifest = defineGameManifestV1({
  apiVersion: 1,
  capabilities: {
    bots: false,
    hiddenInformation: false,
    manualSeatReclaim: false,
    midgameJoin: false,
    soloPractice: false,
    spectators: true,
    temporaryController: false,
    timers: false,
  },
  description: "用于复制并实现新游戏的最小计分示例。",
  displayName: "插件模板",
  gameId: "template-game",
  interactionMode: "turn_based",
  maxPlayers: 2,
  minPlayers: 2,
});
