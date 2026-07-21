import { billiardsServerModule } from "@tabletop/game-billiards/server";
import { gomokuServerModule } from "@tabletop/game-gomoku/server";
import { ludoServerModule } from "@tabletop/game-ludo/server";
import { registerServerGamesV1 } from "@tabletop/game-sdk/server";

export const serverGameRegistry = registerServerGamesV1([
  billiardsServerModule,
  gomokuServerModule,
  ludoServerModule,
]);
