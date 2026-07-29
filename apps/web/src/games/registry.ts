import { billiardsWebModule } from "@tabletop/game-billiards/web";
import { doudizhuWebModule } from "@tabletop/game-doudizhu/web";
import { gomokuWebModule } from "@tabletop/game-gomoku/web";
import { ludoWebModule } from "@tabletop/game-ludo/web";
import { registerWebGamesV1 } from "@tabletop/game-sdk/web";

export const webGameRegistry = registerWebGamesV1([
  billiardsWebModule,
  doudizhuWebModule,
  gomokuWebModule,
  ludoWebModule,
]);
