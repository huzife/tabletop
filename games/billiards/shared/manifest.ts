import { defineGameManifestV1 } from "@tabletop/game-sdk";

export const billiardsManifest = defineGameManifestV1({
  apiVersion: 1,
  capabilities: {
    bots: false,
    hiddenInformation: false,
    manualSeatReclaim: false,
    midgameJoin: false,
    spectators: true,
    temporaryController: false,
    timers: false,
  },
  description: "支持中式八球与斯诺克、旋转和抬杆击球的双人台球。",
  displayName: "台球",
  gameId: "billiards",
  interactionMode: "turn_based",
  maxPlayers: 2,
  minPlayers: 2,
});
