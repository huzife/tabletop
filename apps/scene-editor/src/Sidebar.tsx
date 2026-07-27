import type { SceneElement } from "@tabletop/scene";
import {
  ArrowDown,
  ArrowUp,
  Circle,
  Eye,
  EyeOff,
  ImagePlus,
  Lock,
  Minus,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Pentagon,
  Square,
  Type,
  Unlock,
  Waypoints,
} from "lucide-react";

import { TOOL_SHORTCUTS, elementTypeLabel, roleLabel, type EditorTool } from "./editor-model";

interface SidebarProps {
  readonly elements: readonly SceneElement[];
  readonly selectedId: string | null;
  readonly tool: EditorTool;
  readonly onChange: (element: SceneElement) => void;
  readonly onImage: () => void;
  readonly onReorder: (id: string, direction: "down" | "up") => void;
  readonly onSelect: (id: string) => void;
  readonly onToolChange: (tool: EditorTool) => void;
}

const TOOLS: readonly {
  readonly tool: EditorTool;
  readonly label: string;
  readonly icon: typeof MousePointer2;
}[] = [
  { tool: "select", label: "选择 / 移动", icon: MousePointer2 },
  { tool: "rectangle", label: "矩形", icon: Square },
  { tool: "ellipse", label: "椭圆", icon: Circle },
  { tool: "line", label: "直线", icon: Minus },
  { tool: "arrow", label: "箭头", icon: MoveUpRight },
  { tool: "polyline", label: "折线", icon: Waypoints },
  { tool: "polygon", label: "多边形", icon: Pentagon },
  { tool: "freehand", label: "自由线", icon: Pencil },
  { tool: "text", label: "文字标注", icon: Type },
];

export function Sidebar({
  elements,
  selectedId,
  tool,
  onChange,
  onImage,
  onReorder,
  onSelect,
  onToolChange,
}: SidebarProps) {
  const selectedIndex = elements.findIndex((element) => element.id === selectedId);
  return (
    <aside className="workspace-left">
      <div className="tool-rail" aria-label="绘图工具">
        {TOOLS.map(({ icon: Icon, label, tool: itemTool }) => (
          <button
            aria-label={`${label} (${TOOL_SHORTCUTS[itemTool]})`}
            className={tool === itemTool ? "tool-button is-active" : "tool-button"}
            key={itemTool}
            onClick={() => onToolChange(itemTool)}
            title={`${label} · ${TOOL_SHORTCUTS[itemTool]}`}
            type="button"
          >
            <Icon size={19} strokeWidth={1.9} />
            <span>{TOOL_SHORTCUTS[itemTool]}</span>
          </button>
        ))}
        <span className="tool-separator" />
        <button
          aria-label="插入图片"
          className="tool-button"
          onClick={onImage}
          title="插入图片"
          type="button"
        >
          <ImagePlus size={19} strokeWidth={1.9} />
          <span>I</span>
        </button>
      </div>

      <section className="layers panel">
        <header className="panel-heading layers-heading">
          <div>
            <span className="panel-kicker">对象</span>
            <strong>图层</strong>
          </div>
          <span className="layer-count">{elements.length}</span>
        </header>
        {selectedIndex >= 0 ? (
          <div className="layer-order-actions">
            <button
              disabled={selectedIndex === elements.length - 1}
              onClick={() => {
                if (selectedId !== null) onReorder(selectedId, "up");
              }}
              title="上移一层"
              type="button"
            >
              <ArrowUp size={14} />
              上移
            </button>
            <button
              disabled={selectedIndex === 0}
              onClick={() => {
                if (selectedId !== null) onReorder(selectedId, "down");
              }}
              title="下移一层"
              type="button"
            >
              <ArrowDown size={14} />
              下移
            </button>
          </div>
        ) : null}
        <div className="layer-list">
          {elements.length === 0 ? (
            <div className="layers-empty">
              <span>暂无对象</span>
              <small>绘制的形状、线条、文字和图片会出现在这里。</small>
            </div>
          ) : (
            [...elements].reverse().map((element) => (
              <div
                className={element.id === selectedId ? "layer-row is-selected" : "layer-row"}
                key={element.id}
              >
                <button
                  aria-label={element.visible ? "隐藏元素" : "显示元素"}
                  className="layer-icon-action"
                  onClick={() => onChange({ ...element, visible: !element.visible })}
                  title={element.visible ? "隐藏" : "显示"}
                  type="button"
                >
                  {element.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                <button
                  className="layer-main"
                  onClick={() => onSelect(element.id)}
                  title={`${element.name} · ${elementTypeLabel(element)} · ${roleLabel(element.role)}`}
                  type="button"
                >
                  <span className={`role-dot is-${element.role}`} />
                  <span className="layer-copy">
                    <strong>{element.name}</strong>
                    <small>
                      {elementTypeLabel(element)} · {roleLabel(element.role)}
                    </small>
                  </span>
                </button>
                <button
                  aria-label={element.locked ? "解锁元素" : "锁定元素"}
                  className="layer-icon-action"
                  onClick={() => onChange({ ...element, locked: !element.locked })}
                  title={element.locked ? "解锁" : "锁定"}
                  type="button"
                >
                  {element.locked ? <Lock size={13} /> : <Unlock size={13} />}
                </button>
              </div>
            ))
          )}
        </div>
        <footer className="role-legend">
          <span>
            <i className="role-dot is-visual" /> 视觉
          </span>
          <span>
            <i className="role-dot is-collision" /> 碰撞
          </span>
          <span>
            <i className="role-dot is-both" /> 两者
          </span>
        </footer>
      </section>
    </aside>
  );
}
