import type { GameSettingsPropsV1 } from "@tabletop/game-sdk/web";

import {
  BILLIARDS_SPIN_CONVERGENCE_DEFAULT,
  BILLIARDS_SPIN_CONVERGENCE_MAX,
  BILLIARDS_SPIN_CONVERGENCE_MIN,
  BILLIARDS_SPIN_CONVERGENCE_STEP,
  BILLIARDS_TABLE_FRICTION_DEFAULT,
  BILLIARDS_TABLE_FRICTION_MAX,
  BILLIARDS_TABLE_FRICTION_MIN,
  BILLIARDS_TABLE_FRICTION_STEP,
  formatBilliardsSpinConvergence,
  formatBilliardsTableFriction,
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

      <fieldset className="billiards-settings__group" disabled={disabled}>
        <legend>台面物理</legend>
        <div className="billiards-settings__surface-controls">
          <label className="billiards-settings__friction">
            <span className="billiards-settings__friction-header">
              <strong>台面与边库摩擦</strong>
              <output>{formatBilliardsTableFriction(value.tableFriction)}</output>
            </span>
            <input
              aria-label="台面与边库摩擦系数"
              max={BILLIARDS_TABLE_FRICTION_MAX}
              min={BILLIARDS_TABLE_FRICTION_MIN}
              onChange={(event) =>
                onChange({
                  ...value,
                  tableFriction:
                    Math.round(event.currentTarget.valueAsNumber / BILLIARDS_TABLE_FRICTION_STEP) *
                    BILLIARDS_TABLE_FRICTION_STEP,
                })
              }
              step={BILLIARDS_TABLE_FRICTION_STEP}
              type="range"
              value={value.tableFriction}
            />
            <span aria-hidden="true" className="billiards-settings__friction-scale">
              <span>快台 {BILLIARDS_TABLE_FRICTION_MIN.toFixed(2)}</span>
              <span>标准 {BILLIARDS_TABLE_FRICTION_DEFAULT.toFixed(2)}</span>
              <span>慢台 {BILLIARDS_TABLE_FRICTION_MAX.toFixed(2)}</span>
            </span>
          </label>

          <label className="billiards-settings__friction">
            <span className="billiards-settings__friction-header">
              <strong>高低杆旋转收敛</strong>
              <output>{formatBilliardsSpinConvergence(value.spinConvergence)}</output>
            </span>
            <input
              aria-label="高低杆旋转收敛倍率"
              max={BILLIARDS_SPIN_CONVERGENCE_MAX}
              min={BILLIARDS_SPIN_CONVERGENCE_MIN}
              onChange={(event) =>
                onChange({
                  ...value,
                  spinConvergence: Number(
                    (
                      Math.round(
                        event.currentTarget.valueAsNumber / BILLIARDS_SPIN_CONVERGENCE_STEP,
                      ) * BILLIARDS_SPIN_CONVERGENCE_STEP
                    ).toFixed(1),
                  ),
                })
              }
              step={BILLIARDS_SPIN_CONVERGENCE_STEP}
              type="range"
              value={value.spinConvergence}
            />
            <span aria-hidden="true" className="billiards-settings__friction-scale">
              <span>持久 {BILLIARDS_SPIN_CONVERGENCE_MIN.toFixed(1)}x</span>
              <span>标准 {BILLIARDS_SPIN_CONVERGENCE_DEFAULT.toFixed(1)}x</span>
              <span>快速 {BILLIARDS_SPIN_CONVERGENCE_MAX.toFixed(1)}x</span>
            </span>
          </label>
        </div>
      </fieldset>
    </div>
  );
}
