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

const DIAGRAMS: Readonly<
  Record<BilliardsMode, { readonly alt: string; readonly caption: string; readonly src: string }>
> = {
  "chinese-eight-ball": {
    alt: "中式八球球桌、球洞和球尺寸示意图",
    caption: "中式八球：2540 × 1270 mm 有效比赛区，57.15 mm 球径",
    src: new URL("./assets/chinese-eight-ball-dimensions.png", import.meta.url).href,
  },
  snooker: {
    alt: "斯诺克球桌、球洞、D 区和球尺寸示意图",
    caption: "斯诺克：3569 × 1778 mm 有效比赛区，52.5 mm 球径",
    src: new URL("./assets/snooker-table-dimensions.png", import.meta.url).href,
  },
};

export function BilliardsSettingsEditor({
  disabled,
  onChange,
  value,
}: GameSettingsPropsV1<BilliardsSettings>) {
  const diagram = DIAGRAMS[value.mode];
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
      <figure className="billiards-settings__diagram">
        <a href={diagram.src} rel="noreferrer" target="_blank">
          <img alt={diagram.alt} loading="lazy" src={diagram.src} />
        </a>
        <figcaption>{diagram.caption} · 点击查看原图</figcaption>
      </figure>
    </div>
  );
}
