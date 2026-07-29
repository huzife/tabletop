import { defineGameWebModuleV1 } from "@tabletop/game-sdk/web";

import { doudizhuShared } from "../shared/index.js";
import { DoudizhuGameView } from "./GameView.js";
import "./styles.css";

const RULE_ERRORS: Readonly<Record<string, string>> = {
  DOUDIZHU_BID_NOT_AVAILABLE: "当前不能叫抢地主",
  DOUDIZHU_CALL_REQUIRED: "当前应选择叫地主或不叫",
  DOUDIZHU_CANNOT_PASS: "领出新一轮时不能不出",
  DOUDIZHU_CARD_NOT_OWNED: "所选牌不在你的手牌中",
  DOUDIZHU_DOUBLE_NOT_AVAILABLE: "当前不能选择加倍",
  DOUDIZHU_DUPLICATE_CARD: "不能重复选择同一张牌",
  DOUDIZHU_INVALID_PATTERN: "所选卡牌不能组成有效牌型",
  DOUDIZHU_MATCH_ENDED: "本局已经结束",
  DOUDIZHU_NOT_YOUR_TURN: "还没有轮到你操作",
  DOUDIZHU_OPEN_HAND_NOT_AVAILABLE: "当前不能选择明牌",
  DOUDIZHU_PLAY_NOT_AVAILABLE: "当前不能出牌",
  DOUDIZHU_PLAY_TOO_SMALL: "所选牌型不能压过上一手",
  DOUDIZHU_REQUIRES_THREE_PLAYERS: "斗地主需要坐满三席",
  DOUDIZHU_ROB_REQUIRED: "当前应选择抢地主或不抢",
};

export const doudizhuWebModule = defineGameWebModuleV1({
  shared: doudizhuShared,
  GameView: DoudizhuGameView,
  formatRuleError: (ruleCode) => RULE_ERRORS[ruleCode] ?? "该操作不符合当前斗地主规则",
});
