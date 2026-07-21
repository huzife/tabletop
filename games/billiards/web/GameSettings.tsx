import type { GameSettingsPropsV1 } from "@tabletop/game-sdk/web";

import type { BilliardsMode, BilliardsSettings } from "../shared/settings.js";

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
    <fieldset className="billiards-settings" disabled={disabled}>
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
              onChange={() => onChange({ mode: mode.value })}
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
  );
}
