import type { GameSettingsPropsV1 } from "@tabletop/game-sdk/web";

import {
  CLOTH_ROLLING_FRICTION_RANGE,
  CLOTH_SLIDING_FRICTION_RANGE,
  type BilliardsMode,
  type BilliardsSettings,
} from "../shared/settings.js";

const MODES: readonly {
  readonly description: string;
  readonly label: string;
  readonly value: BilliardsMode;
}[] = [
  {
    description: "16 球，开球后按球组完成比赛",
    label: "中式八球",
    value: "chinese-eight-ball",
  },
  {
    description: "22 球，按红球和彩球顺序计分",
    label: "斯诺克",
    value: "snooker",
  },
];

export function BilliardsSettingsEditor({
  disabled,
  onChange,
  value,
}: GameSettingsPropsV1<BilliardsSettings>) {
  return (
    <div className="billiards-settings">
      <fieldset className="billiards-settings__group" disabled={disabled}>
        <legend>比赛模式</legend>
        <div className="billiards-settings__modes">
          {MODES.map((mode) => (
            <label
              className={
                value.mode === mode.value
                  ? "billiards-settings__mode is-selected"
                  : "billiards-settings__mode"
              }
              key={mode.value}
            >
              <input
                checked={value.mode === mode.value}
                name="billiards-mode"
                onChange={() => onChange({ ...value, mode: mode.value })}
                type="radio"
                value={mode.value}
              />
              <span>
                <strong>{mode.label}</strong>
                <small>{mode.description}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {value.mode === "chinese-eight-ball" ? (
        <fieldset className="billiards-settings__group" disabled={disabled}>
          <legend>台布参数</legend>
          <div className="billiards-settings__physics">
            <label className="billiards-settings__parameter">
              <span>
                <strong>滑动摩擦</strong>
                <output>{value.clothSlidingFriction.toFixed(3)}</output>
              </span>
              <input
                aria-label="滑动摩擦"
                max={CLOTH_SLIDING_FRICTION_RANGE.max}
                min={CLOTH_SLIDING_FRICTION_RANGE.min}
                onChange={(event) =>
                  onChange({
                    ...value,
                    clothSlidingFriction: event.currentTarget.valueAsNumber,
                  })
                }
                step={CLOTH_SLIDING_FRICTION_RANGE.step}
                type="range"
                value={value.clothSlidingFriction}
              />
              <small>越低，低杆和高杆保持原有旋转的时间越长。</small>
            </label>
            <label className="billiards-settings__parameter">
              <span>
                <strong>滚动摩擦</strong>
                <output>{value.clothRollingFriction.toFixed(3)}</output>
              </span>
              <input
                aria-label="滚动摩擦"
                max={CLOTH_ROLLING_FRICTION_RANGE.max}
                min={CLOTH_ROLLING_FRICTION_RANGE.min}
                onChange={(event) =>
                  onChange({
                    ...value,
                    clothRollingFriction: event.currentTarget.valueAsNumber,
                  })
                }
                step={CLOTH_ROLLING_FRICTION_RANGE.step}
                type="range"
                value={value.clothRollingFriction}
              />
              <small>越低，球进入自然滚动后滑行得越远。</small>
            </label>
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}
