import { defineGameManifestV1 } from "@tabletop/game-sdk";

export const billiardsManifest = defineGameManifestV1({
  apiVersion: 1,
  capabilities: {
    bots: false,
    hiddenInformation: false,
    manualSeatReclaim: false,
    midgameJoin: false,
    soloPractice: true,
    spectators: true,
    temporaryController: false,
    timers: false,
  },
  description: "支持单人练习及双人中式八球与斯诺克，包含旋转和抬杆击球。",
  displayName: "台球",
  gameId: "billiards",
  interactionMode: "turn_based",
  maxPlayers: 2,
  minPlayers: 2,
});
