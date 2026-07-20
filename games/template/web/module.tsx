import { defineGameWebModuleV1 } from "@tabletop/game-sdk/web";

import { templateShared } from "../shared/contract.js";

export const templateWebModule = defineGameWebModuleV1({
  shared: templateShared,
  SettingsEditor: ({ disabled, onChange, value }) => (
    <label>
      获胜分数
      <input
        disabled={disabled}
        max={20}
        min={1}
        onChange={(event) => onChange({ targetScore: event.currentTarget.valueAsNumber })}
        type="number"
        value={value.targetScore}
      />
    </label>
  ),
  GameView: ({ actionPending, dispatchAction, readOnly, view }) => (
    <section aria-label="模板游戏区域">
      <h2>先得 {view.targetScore} 分</h2>
      <ol>
        {view.scores.map(({ score, seatId }) => (
          <li key={seatId}>
            {seatId}: {score}
          </li>
        ))}
      </ol>
      <button
        disabled={readOnly || actionPending || !view.canScore}
        onClick={() => dispatchAction({ type: "template.score" })}
        type="button"
      >
        得分
      </button>
    </section>
  ),
  formatRuleError: (code) => (code === "NOT_YOUR_TURN" ? "还没有轮到你" : "当前不能执行该操作"),
});
