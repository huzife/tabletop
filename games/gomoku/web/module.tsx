import { defineGameWebModuleV1 } from "@tabletop/game-sdk/web";

import { gomokuShared } from "../shared/contract.js";
import { GomokuGameView } from "./GameView.js";
import { GomokuSettingsEditor } from "./GameSettings.js";
import "./styles.css";

const RULE_ERRORS: Readonly<Record<string, string>> = {
  ACTION_BLOCKED_BY_UNDO: "悔棋申请处理完成前不能落子",
  BOTS_NOT_ALLOWED_IN_RENJU: "连珠禁手规则不能添加 AI 玩家",
  DRAW_ALREADY_OFFERED: "当前局面已经提议过和棋",
  FORBIDDEN_MOVE: "该位置是黑方禁手",
  MATCH_ENDED: "本局已经结束",
  NOT_OFFER_RECIPIENT: "只有对方可以回应这项申请",
  NOT_YOUR_TURN: "还没有轮到你落子",
  OFFER_ALREADY_PENDING: "已有一项申请等待处理",
  OUT_OF_BOUNDS: "落子位置超出棋盘",
  POSITION_OCCUPIED: "该位置已有棋子",
  UNDO_NOT_AVAILABLE: "当前不能申请悔棋",
};

export const gomokuWebModule = defineGameWebModuleV1({
  shared: gomokuShared,
  SettingsEditor: GomokuSettingsEditor,
  GameView: GomokuGameView,
  formatRuleError: (ruleCode) => RULE_ERRORS[ruleCode] ?? "该操作不符合当前规则",
});
