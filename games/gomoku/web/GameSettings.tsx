import type { GameSettingsPropsV1 } from "@tabletop/game-sdk/web";

import type { GomokuRule, GomokuSettings } from "../shared/settings.js";

const RULES: readonly { readonly value: GomokuRule; readonly label: string }[] = [
  { value: "freestyle", label: "自由规则" },
  { value: "standard", label: "标准规则" },
  { value: "renju", label: "连珠禁手" },
];

export function GomokuSettingsEditor({
  value,
  disabled,
  onChange,
}: GameSettingsPropsV1<GomokuSettings>) {
  const update = <Key extends keyof GomokuSettings>(key: Key, next: GomokuSettings[Key]) => {
    onChange({ ...value, [key]: next });
  };

  return (
    <div className="gomoku-settings">
      <fieldset className="gomoku-settings__group" disabled={disabled}>
        <legend>规则</legend>
        <div className="gomoku-segmented">
          {RULES.map((rule) => (
            <label
              className={
                value.rule === rule.value
                  ? "gomoku-segmented__item is-selected"
                  : "gomoku-segmented__item"
              }
              key={rule.value}
            >
              <input
                checked={value.rule === rule.value}
                name="gomoku-rule"
                onChange={() => update("rule", rule.value)}
                type="radio"
                value={rule.value}
              />
              <span>{rule.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="gomoku-toggle">
        <input
          checked={value.timerEnabled}
          disabled={disabled}
          onChange={(event) => update("timerEnabled", event.currentTarget.checked)}
          type="checkbox"
        />
        <span aria-hidden="true" className="gomoku-toggle__track" />
        <span>启用计时</span>
      </label>

      {value.timerEnabled ? (
        <div className="gomoku-settings__timers">
          <label>
            <span>每方总时间</span>
            <span className="gomoku-number-field">
              <input
                disabled={disabled}
                max={60}
                min={1}
                onChange={(event) =>
                  update("totalTimeMinutes", clamp(Number(event.currentTarget.value), 1, 60))
                }
                type="number"
                value={value.totalTimeMinutes}
              />
              <span>分钟</span>
            </span>
          </label>
          <label>
            <span>每步时间</span>
            <span className="gomoku-number-field">
              <input
                disabled={disabled}
                max={300}
                min={5}
                onChange={(event) =>
                  update("moveTimeSeconds", clamp(Number(event.currentTarget.value), 5, 300))
                }
                step={5}
                type="number"
                value={value.moveTimeSeconds}
              />
              <span>秒</span>
            </span>
          </label>
        </div>
      ) : null}
    </div>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
