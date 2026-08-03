import { defineGameWebModuleV1 } from "@tabletop/game-sdk/web";

import { initializeBilliardsPhysics } from "../physics/browser.js";
import { billiardsShared } from "../shared/contract.js";
import { BilliardsGameView } from "./GameView.js";
import { BilliardsSettingsEditor } from "./GameSettings.js";
import "./styles.css";

const RULE_ERRORS: Readonly<Record<string, string>> = {
  BALLS_MOVING: "台球仍在运动",
  BREAK_CHOICE_NOT_AVAILABLE: "当前开球处理选项不可用",
  COLOR_NOMINATION_REQUIRED: "请选择本杆目标彩球",
  CUE_IN_POCKET: "母球不能放在袋口",
  CUE_NOT_IN_HAND: "当前不能摆放母球",
  CUE_OUT_OF_BOUNDS: "母球位置超出台面",
  CUE_OUTSIDE_D: "母球必须放在 D 区内",
  CUE_OUTSIDE_BEHIND_LINE: "母球必须放在发球线后",
  CUE_OVERLAPS_BALL: "母球不能与其他球重叠",
  FIXED_SHOT_POWER_REQUIRED: "本杆必须使用房间预设力度",
  GROUP_CHOICE_NOT_AVAILABLE: "当前球组选项不可用",
  INVALID_SHOT: "击球参数无效",
  MATCH_ENDED: "本局已经结束",
  NOT_YOUR_TURN: "还没有轮到你",
  NO_BREAK_DECISION_PENDING: "当前没有待处理的开球裁定",
  NO_GROUP_DECISION_PENDING: "当前没有待选择的球组",
  PLACE_CUE_FIRST: "请先摆放母球",
  PLAYER_ONLY: "只有对局玩家可以操作",
  REQUIRES_TWO_PLAYERS: "台球对局需要两名玩家",
  RESIGN_NOT_ALLOWED: "当前不能认输",
  SHOT_IN_PROGRESS: "正在结算上一杆",
};

if (typeof window !== "undefined") {
  void initializeBilliardsPhysics().catch(() => {
    // The shared loader clears its cache after a failure so the game view can retry.
  });
}

export const billiardsWebModule = defineGameWebModuleV1({
  shared: billiardsShared,
  SettingsEditor: BilliardsSettingsEditor,
  GameView: BilliardsGameView,
  formatRuleError: (ruleCode) => RULE_ERRORS[ruleCode] ?? "该操作不符合当前台球规则",
});
