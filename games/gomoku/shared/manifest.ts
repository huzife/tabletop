import { defineGameManifestV1 } from "@tabletop/game-sdk";

export const gomokuManifest = defineGameManifestV1({
  apiVersion: 1,
  gameId: "gomoku",
  displayName: "五子棋",
  description: "支持自由、标准与连珠禁手规则的 15 路五子棋。",
  minPlayers: 2,
  maxPlayers: 2,
  interactionMode: "turn_based",
  capabilities: {
    spectators: true,
    midgameJoin: false,
    timers: true,
    hiddenInformation: false,
    bots: true,
    soloPractice: false,
    temporaryController: true,
    manualSeatReclaim: false,
  },
});
