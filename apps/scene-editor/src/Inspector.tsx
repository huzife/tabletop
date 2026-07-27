import type { SceneDocument, SceneElement, SceneStyle } from "@tabletop/scene";
import { Copy, Lock, Trash2, Unlock } from "lucide-react";
import { useEffect, useState } from "react";

import { elementTypeLabel, roleLabel } from "./editor-model";

interface InspectorProps {
  readonly document: SceneDocument;
  readonly element: SceneElement | undefined;
  readonly onChangeDocument: (document: SceneDocument) => void;
  readonly onChangeElement: (element: SceneElement) => void;
  readonly onDelete: (id: string) => void;
  readonly onDuplicate: (element: SceneElement) => void;
}

export function Inspector({
  document,
  element,
  onChangeDocument,
  onChangeElement,
  onDelete,
  onDuplicate,
}: InspectorProps) {
  if (element === undefined) {
    return <SceneInspector document={document} onChange={onChangeDocument} />;
  }

  const changeStyle = (style: Partial<SceneStyle>) => {
    onChangeElement({ ...element, style: { ...element.style, ...style } });
  };

  return (
    <aside className="inspector panel">
      <header className="panel-heading inspector-heading">
        <div>
          <span className="panel-kicker">当前选择</span>
          <strong>{elementTypeLabel(element)}</strong>
        </div>
        <div className="compact-actions">
          <button
            aria-label={element.locked ? "解锁元素" : "锁定元素"}
            className="icon-control"
            onClick={() => onChangeElement({ ...element, locked: !element.locked })}
            title={element.locked ? "解锁元素" : "锁定元素"}
            type="button"
          >
            {element.locked ? <Lock size={15} /> : <Unlock size={15} />}
          </button>
          <button
            aria-label="复制元素"
            className="icon-control"
            onClick={() => onDuplicate(element)}
            title="复制元素"
            type="button"
          >
            <Copy size={15} />
          </button>
          <button
            aria-label="删除元素"
            className="icon-control is-danger"
            onClick={() => onDelete(element.id)}
            title="删除元素"
            type="button"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </header>

      <div className="inspector-scroll">
        <InspectorSection title="元素">
          <TextField
            label="名称"
            onChange={(name) => onChangeElement({ ...element, name })}
            value={element.name}
          />
          <div className="field">
            <span className="field-label">用途</span>
            <div className="segmented segmented--three">
              {(["visual", "collision", "both"] as const).map((role) => (
                <button
                  className={element.role === role ? "is-active" : ""}
                  key={role}
                  onClick={() => onChangeElement({ ...element, role })}
                  title={roleLabel(role)}
                  type="button"
                >
                  {role === "visual" ? "视觉" : role === "collision" ? "碰撞" : "两者"}
                </button>
              ))}
            </div>
          </div>
          <div className="field-row">
            <NumberField
              label="旋转°"
              onChange={(rotation) => onChangeElement({ ...element, rotation })}
              step={1}
              value={element.rotation}
            />
            <NumberField
              label="透明度"
              max={1}
              min={0}
              onChange={(opacity) => onChangeElement({ ...element, opacity })}
              step={0.05}
              value={element.opacity}
            />
          </div>
          <label className="toggle-line">
            <input
              checked={element.visible}
              onChange={(event) => onChangeElement({ ...element, visible: event.target.checked })}
              type="checkbox"
            />
            <span>在场景中可见</span>
          </label>
        </InspectorSection>

        <GeometryInspector element={element} onChange={onChangeElement} />

        {element.type !== "image" && element.type !== "text" ? (
          <InspectorSection title="外观">
            {element.type !== "line" &&
            element.type !== "freehand" &&
            !(element.type === "polyline" && !element.closed) ? (
              <>
                <ColorField
                  label="填充"
                  onChange={(fill) => changeStyle({ fill })}
                  value={element.style.fill}
                />
                <NumberField
                  label="填充透明度"
                  max={1}
                  min={0}
                  onChange={(fillOpacity) => changeStyle({ fillOpacity })}
                  step={0.05}
                  value={element.style.fillOpacity}
                />
              </>
            ) : null}
            <ColorField
              label="描边"
              onChange={(stroke) => changeStyle({ stroke })}
              value={element.style.stroke}
            />
            <div className="field-row">
              <NumberField
                label="线宽"
                min={0}
                onChange={(strokeWidth) => changeStyle({ strokeWidth })}
                step={0.5}
                value={element.style.strokeWidth}
              />
              <NumberField
                label="描边透明度"
                max={1}
                min={0}
                onChange={(strokeOpacity) => changeStyle({ strokeOpacity })}
                step={0.05}
                value={element.style.strokeOpacity}
              />
            </div>
            <SelectField
              label="线型"
              onChange={(value) => changeStyle({ dash: dashFromName(value) })}
              options={[
                ["solid", "实线"],
                ["dashed", "虚线"],
                ["dotted", "点线"],
              ]}
              value={dashName(element.style.dash)}
            />
            <div className="field-row">
              <SelectField
                label="端点"
                onChange={(lineCap) => changeStyle({ lineCap: lineCap as SceneStyle["lineCap"] })}
                options={[
                  ["round", "圆形"],
                  ["butt", "平直"],
                  ["square", "方形"],
                ]}
                value={element.style.lineCap}
              />
              <SelectField
                label="转角"
                onChange={(lineJoin) =>
                  changeStyle({ lineJoin: lineJoin as SceneStyle["lineJoin"] })
                }
                options={[
                  ["round", "圆角"],
                  ["miter", "尖角"],
                  ["bevel", "斜角"],
                ]}
                value={element.style.lineJoin}
              />
            </div>
          </InspectorSection>
        ) : null}

        <InspectorSection title="标注与游戏数据">
          <TextField
            label="画布标注"
            onChange={(label) =>
              onChangeElement({
                ...element,
                metadata: { ...element.metadata, label },
              })
            }
            placeholder="例如：出生点、危险区"
            value={element.metadata.label}
          />
          <TextAreaField
            label="备注"
            onChange={(notes) =>
              onChangeElement({
                ...element,
                metadata: { ...element.metadata, notes },
              })
            }
            placeholder="记录用途、规则或对齐说明"
            value={element.metadata.notes}
          />
          <TextField
            label="标签"
            onChange={(value) =>
              onChangeElement({
                ...element,
                metadata: {
                  ...element.metadata,
                  tags: value
                    .split(",")
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                },
              })
            }
            placeholder="wall, spawn, ui"
            value={element.metadata.tags.join(", ")}
          />
          <div className="data-contract-note">
            <span>元素 ID</span>
            <code title={element.id}>{element.id}</code>
          </div>
        </InspectorSection>
      </div>
    </aside>
  );
}

function SceneInspector({
  document,
  onChange,
}: {
  readonly document: SceneDocument;
  readonly onChange: (document: SceneDocument) => void;
}) {
  const changeCanvas = (canvas: Partial<SceneDocument["canvas"]>) => {
    onChange({ ...document, canvas: { ...document.canvas, ...canvas } });
  };
  return (
    <aside className="inspector panel">
      <header className="panel-heading">
        <span className="panel-kicker">场景设置</span>
        <strong>画布与坐标</strong>
      </header>
      <div className="inspector-scroll">
        <InspectorSection title="描述文件">
          <TextField
            label="场景名称"
            onChange={(name) => onChange({ ...document, name })}
            value={document.name}
          />
          <div className="field-row">
            <NumberField
              label="宽度"
              min={1}
              onChange={(width) => changeCanvas({ width })}
              step={1}
              value={document.canvas.width}
            />
            <NumberField
              label="高度"
              min={1}
              onChange={(height) => changeCanvas({ height })}
              step={1}
              value={document.canvas.height}
            />
          </div>
          <div className="field-row">
            <ColorField
              label="背景"
              onChange={(background) => changeCanvas({ background })}
              value={document.canvas.background}
            />
            <NumberField
              label="网格"
              min={1}
              onChange={(gridSize) => changeCanvas({ gridSize })}
              step={1}
              value={document.canvas.gridSize}
            />
          </div>
        </InspectorSection>

        <InspectorSection title="坐标契约">
          <div className="coordinate-card">
            <div className="coordinate-axis">
              <span className="axis-origin">0,0</span>
              <span className="axis-x">X →</span>
              <span className="axis-y">Y ↓</span>
            </div>
            <p>左上角为原点，X 向右，Y 向下；1 scene-unit 在设计尺寸下对应 1 像素。</p>
          </div>
          <dl className="contract-list">
            <div>
              <dt>缩放</dt>
              <dd>contain 等比缩放</dd>
            </div>
            <div>
              <dt>格式</dt>
              <dd>tabletop.scene/v1</dd>
            </div>
            <div>
              <dt>层级</dt>
              <dd>数组顺序由下至上</dd>
            </div>
          </dl>
        </InspectorSection>

        <div className="inspector-tip">
          选择左侧工具后在画布拖动。按住 Alt
          可临时关闭网格吸附；选中元素后可拖动或用右下角控制点缩放。
        </div>
      </div>
    </aside>
  );
}

function GeometryInspector({
  element,
  onChange,
}: {
  readonly element: SceneElement;
  readonly onChange: (element: SceneElement) => void;
}) {
  switch (element.type) {
    case "rectangle":
      return (
        <InspectorSection title="矩形参数">
          <div className="field-grid">
            <NumberField
              label="X"
              onChange={(x) => onChange({ ...element, x })}
              value={element.x}
            />
            <NumberField
              label="Y"
              onChange={(y) => onChange({ ...element, y })}
              value={element.y}
            />
            <NumberField
              label="宽度"
              min={1}
              onChange={(width) => onChange({ ...element, width })}
              value={element.width}
            />
            <NumberField
              label="高度"
              min={1}
              onChange={(height) => onChange({ ...element, height })}
              value={element.height}
            />
          </div>
          <NumberField
            label="圆角半径"
            min={0}
            onChange={(cornerRadius) => onChange({ ...element, cornerRadius })}
            value={element.cornerRadius}
          />
        </InspectorSection>
      );
    case "ellipse":
      return (
        <InspectorSection title="椭圆参数">
          <div className="field-grid">
            <NumberField
              label="中心 X"
              onChange={(cx) => onChange({ ...element, cx })}
              value={element.cx}
            />
            <NumberField
              label="中心 Y"
              onChange={(cy) => onChange({ ...element, cy })}
              value={element.cy}
            />
            <NumberField
              label="半径 X"
              min={1}
              onChange={(rx) => onChange({ ...element, rx })}
              value={element.rx}
            />
            <NumberField
              label="半径 Y"
              min={1}
              onChange={(ry) => onChange({ ...element, ry })}
              value={element.ry}
            />
          </div>
          <div className="formula-note">碰撞公式：(x − cx)² / rx² + (y − cy)² / ry² ≤ 1</div>
        </InspectorSection>
      );
    case "line":
      return (
        <InspectorSection title="线段参数">
          <div className="field-grid">
            <NumberField
              label="起点 X"
              onChange={(x) => onChange({ ...element, start: { ...element.start, x } })}
              value={element.start.x}
            />
            <NumberField
              label="起点 Y"
              onChange={(y) => onChange({ ...element, start: { ...element.start, y } })}
              value={element.start.y}
            />
            <NumberField
              label="终点 X"
              onChange={(x) => onChange({ ...element, end: { ...element.end, x } })}
              value={element.end.x}
            />
            <NumberField
              label="终点 Y"
              onChange={(y) => onChange({ ...element, end: { ...element.end, y } })}
              value={element.end.y}
            />
          </div>
          <div className="field-row">
            <label className="toggle-line">
              <input
                checked={element.arrowStart}
                onChange={(event) => onChange({ ...element, arrowStart: event.target.checked })}
                type="checkbox"
              />
              <span>起点箭头</span>
            </label>
            <label className="toggle-line">
              <input
                checked={element.arrowEnd}
                onChange={(event) => onChange({ ...element, arrowEnd: event.target.checked })}
                type="checkbox"
              />
              <span>终点箭头</span>
            </label>
          </div>
        </InspectorSection>
      );
    case "polyline":
      return (
        <InspectorSection title={element.closed ? "多边形参数" : "折线参数"}>
          <div className="stat-line">
            <span>节点数量</span>
            <strong>{element.points.length}</strong>
          </div>
          <label className="toggle-line">
            <input
              checked={element.closed}
              onChange={(event) => onChange({ ...element, closed: event.target.checked })}
              type="checkbox"
            />
            <span>闭合路径</span>
          </label>
          <PointSummary points={element.points} />
        </InspectorSection>
      );
    case "freehand":
      return (
        <InspectorSection title="自由线参数">
          <div className="stat-line">
            <span>采样点</span>
            <strong>{element.points.length}</strong>
          </div>
          <NumberField
            label="平滑度"
            max={1}
            min={0}
            onChange={(smoothing) => onChange({ ...element, smoothing })}
            step={0.05}
            value={element.smoothing}
          />
          <PointSummary points={element.points} />
        </InspectorSection>
      );
    case "text":
      return (
        <>
          <InspectorSection title="文字内容">
            <TextAreaField
              label="文字"
              onChange={(text) => onChange({ ...element, text })}
              value={element.text}
            />
            <div className="field-grid">
              <NumberField
                label="X"
                onChange={(x) => onChange({ ...element, x })}
                value={element.x}
              />
              <NumberField
                label="Y"
                onChange={(y) => onChange({ ...element, y })}
                value={element.y}
              />
              <NumberField
                label="字号"
                min={1}
                onChange={(fontSize) => onChange({ ...element, fontSize })}
                value={element.fontSize}
              />
              <NumberField
                label="最大宽度"
                min={1}
                onChange={(maxWidth) => onChange({ ...element, maxWidth })}
                value={element.maxWidth}
              />
            </div>
            <TextField
              label="字体"
              onChange={(fontFamily) => onChange({ ...element, fontFamily })}
              value={element.fontFamily}
            />
            <div className="field-row">
              <SelectField
                label="字重"
                onChange={(fontWeight) =>
                  onChange({
                    ...element,
                    fontWeight: fontWeight as typeof element.fontWeight,
                  })
                }
                options={[
                  ["normal", "常规"],
                  ["medium", "中等"],
                  ["semibold", "半粗"],
                  ["bold", "粗体"],
                ]}
                value={element.fontWeight}
              />
              <SelectField
                label="对齐"
                onChange={(align) => onChange({ ...element, align: align as typeof element.align })}
                options={[
                  ["left", "左"],
                  ["center", "中"],
                  ["right", "右"],
                ]}
                value={element.align}
              />
            </div>
            <ColorField
              label="文字颜色"
              onChange={(fill) => onChange({ ...element, style: { ...element.style, fill } })}
              value={element.style.fill}
            />
          </InspectorSection>
        </>
      );
    case "image":
      return (
        <>
          <InspectorSection title="图片参数">
            <div className="field-grid">
              <NumberField
                label="X"
                onChange={(x) => onChange({ ...element, x })}
                value={element.x}
              />
              <NumberField
                label="Y"
                onChange={(y) => onChange({ ...element, y })}
                value={element.y}
              />
              <NumberField
                label="宽度"
                min={1}
                onChange={(width) => onChange({ ...element, width })}
                value={element.width}
              />
              <NumberField
                label="高度"
                min={1}
                onChange={(height) => onChange({ ...element, height })}
                value={element.height}
              />
            </div>
            <TextAreaField
              label="资源链接"
              onChange={(source) => onChange({ ...element, source })}
              value={element.source}
            />
            <TextField
              label="替代文本"
              onChange={(alt) => onChange({ ...element, alt })}
              value={element.alt}
            />
            <SelectField
              label="填充方式"
              onChange={(fit) => onChange({ ...element, fit: fit as typeof element.fit })}
              options={[
                ["contain", "完整显示"],
                ["cover", "裁切填满"],
                ["fill", "拉伸填满"],
              ]}
              value={element.fit}
            />
            <div className="formula-note">
              资源链接会随元素写入 JSON；相对链接以场景描述文件地址为基准解析。
            </div>
          </InspectorSection>
        </>
      );
  }
}

function InspectorSection({
  children,
  title,
}: {
  readonly children: React.ReactNode;
  readonly title: string;
}) {
  return (
    <section className="inspector-section">
      <h2>{title}</h2>
      <div className="inspector-fields">{children}</div>
    </section>
  );
}

function TextField({
  label,
  onChange,
  placeholder,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly value: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type="text"
        value={value}
      />
    </label>
  );
}

function TextAreaField({
  label,
  onChange,
  placeholder,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly value: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <textarea
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={3}
        value={value}
      />
    </label>
  );
}

function NumberField({
  label,
  max,
  min,
  onChange,
  step = 0.1,
  value,
}: {
  readonly label: string;
  readonly max?: number;
  readonly min?: number;
  readonly onChange: (value: number) => void;
  readonly step?: number;
  readonly value: number;
}) {
  const [draft, setDraft] = useState(formatNumber(value));
  useEffect(() => setDraft(formatNumber(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(formatNumber(value));
      return;
    }
    const constrained = Math.min(
      max ?? Number.POSITIVE_INFINITY,
      Math.max(min ?? Number.NEGATIVE_INFINITY, parsed),
    );
    setDraft(formatNumber(constrained));
    if (constrained !== value) onChange(constrained);
  };
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        max={max}
        min={min}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(formatNumber(value));
            event.currentTarget.blur();
          }
        }}
        step={step}
        type="number"
        value={draft}
      />
    </label>
  );
}

function ColorField({
  label,
  onChange,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  const color = /^#[\da-f]{6}$/i.test(value) ? value : "#000000";
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="color-field">
        <input
          aria-label={`${label}颜色选择`}
          onChange={(event) => onChange(event.target.value)}
          type="color"
          value={color}
        />
        <input
          aria-label={`${label}颜色值`}
          onChange={(event) => onChange(event.target.value)}
          type="text"
          value={value}
        />
      </span>
    </label>
  );
}

function SelectField({
  label,
  onChange,
  options,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly (readonly [string, string])[];
  readonly value: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select onChange={(event) => onChange(event.target.value)} value={value}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function PointSummary({ points }: { readonly points: readonly { x: number; y: number }[] }) {
  const first = points[0];
  const last = points.at(-1);
  return (
    <div className="point-summary">
      <span>
        首点{" "}
        <code>
          {first === undefined ? "—" : `${formatNumber(first.x)}, ${formatNumber(first.y)}`}
        </code>
      </span>
      <span>
        末点{" "}
        <code>{last === undefined ? "—" : `${formatNumber(last.x)}, ${formatNumber(last.y)}`}</code>
      </span>
      <small>完整节点坐标保存在导出的描述文件中。</small>
    </div>
  );
}

function dashName(dash: readonly number[]): string {
  if (dash.length === 0) return "solid";
  return dash[0] !== undefined && dash[0] <= 3 ? "dotted" : "dashed";
}

function dashFromName(name: string): number[] {
  if (name === "dotted") return [2, 6];
  if (name === "dashed") return [10, 6];
  return [];
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}
