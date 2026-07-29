import { defineGameManifestV1 } from "@tabletop/game-sdk";

export const doudizhuManifest = defineGameManifestV1({
  apiVersion: 1,
  gameId: "doudizhu",
  displayName: "斗地主",
  description: "三人经典抢地主，支持明牌、加倍、标准 AI 与断线接管。",
  minPlayers: 3,
  maxPlayers: 3,
  interactionMode: "turn_based",
  capabilities: {
    spectators: true,
    midgameJoin: false,
    timers: false,
    hiddenInformation: true,
    bots: true,
    soloPractice: false,
    temporaryController: true,
    manualSeatReclaim: true,
  },
});
