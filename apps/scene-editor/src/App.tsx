import {
  parseSceneJson,
  serializeSceneDocument,
  type SceneDocument,
  type SceneElement,
  type ScenePoint,
} from "@tabletop/scene";
import {
  Check,
  ChevronDown,
  Download,
  FileJson,
  FolderOpen,
  Grid3X3,
  ImagePlus,
  Magnet,
  Redo2,
  RotateCcw,
  ScanSearch,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  TOOL_SHORTCUTS,
  createEmptyScene,
  createImageElement,
  duplicateElement,
  moveElementWithinCanvas,
  replaceElement,
  type EditorTool,
} from "./editor-model";
import { Inspector } from "./Inspector";
import { SceneCanvas } from "./SceneCanvas";
import { Sidebar } from "./Sidebar";

const AUTOSAVE_KEY = "tabletop.scene-editor.autosave.v1";
const HISTORY_LIMIT = 100;

interface EditorHistory {
  readonly past: readonly SceneDocument[];
  readonly present: SceneDocument;
  readonly future: readonly SceneDocument[];
}

interface Notice {
  readonly kind: "error" | "success";
  readonly text: string;
}

export function App() {
  const [history, setHistory] = useState<EditorHistory>(loadInitialHistory);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<EditorTool>("select");
  const [showGrid, setShowGrid] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [showCollision, setShowCollision] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [zoom, setZoom] = useState(0.65);
  const [pointerPosition, setPointerPosition] = useState<ScenePoint | null>(null);
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const document = history.present;
  const selectedElement = document.elements.find((element) => element.id === selectedId);

  const commit = useCallback(
    (next: SceneDocument | ((current: SceneDocument) => SceneDocument)) => {
      setHistory((current) => {
        const nextDocument = typeof next === "function" ? next(current.present) : next;
        if (nextDocument === current.present) return current;
        return {
          past: [...current.past.slice(-(HISTORY_LIMIT - 1)), current.present],
          present: nextDocument,
          future: [],
        };
      });
    },
    [],
  );

  const undo = useCallback(() => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (previous === undefined) return current;
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((current) => {
      const next = current.future[0];
      if (next === undefined) return current;
      return {
        past: [...current.past, current.present],
        present: next,
        future: current.future.slice(1),
      };
    });
  }, []);

  const changeElement = useCallback(
    (element: SceneElement) => {
      commit((current) => ({
        ...current,
        elements: replaceElement(current.elements, element),
      }));
    },
    [commit],
  );

  const addElement = useCallback(
    (element: SceneElement) => {
      commit((current) => ({ ...current, elements: [...current.elements, element] }));
    },
    [commit],
  );

  const deleteElement = useCallback(
    (id: string) => {
      commit((current) => ({
        ...current,
        elements: current.elements.filter((element) => element.id !== id),
      }));
      setSelectedId((current) => (current === id ? null : current));
    },
    [commit],
  );

  const duplicate = useCallback(
    (element: SceneElement) => {
      const copy = duplicateElement(element);
      addElement(copy);
      setSelectedId(copy.id);
    },
    [addElement],
  );

  const reorder = useCallback(
    (id: string, direction: "down" | "up") => {
      commit((current) => {
        const index = current.elements.findIndex((element) => element.id === id);
        const target = direction === "up" ? index + 1 : index - 1;
        if (index < 0 || target < 0 || target >= current.elements.length) return current;
        const elements = [...current.elements];
        const selected = elements[index];
        const neighbor = elements[target];
        if (selected === undefined || neighbor === undefined) return current;
        elements[index] = neighbor;
        elements[target] = selected;
        return { ...current, elements };
      });
    },
    [commit],
  );

  const exportDocument = useCallback(() => {
    try {
      const contents = serializeSceneDocument(document);
      const blob = new Blob([contents], { type: "application/json" });
      const link = window.document.createElement("a");
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = `${safeFileName(document.name)}.scene.json`;
      window.document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice({ kind: "success", text: "描述文件已导出" });
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "导出失败",
      });
    }
  }, [document]);

  const newDocument = () => {
    if (
      document.elements.length > 0 &&
      !window.confirm("新建场景会清空当前画布。已导出的文件不受影响，是否继续？")
    ) {
      return;
    }
    setHistory({ past: [], present: createEmptyScene(), future: [] });
    setSelectedId(null);
    setTool("select");
    setNotice({ kind: "success", text: "已新建空白场景" });
  };

  const importDocument = async (file: File) => {
    try {
      const imported = parseSceneJson(await file.text());
      commit(imported);
      setSelectedId(null);
      setTool("select");
      setNotice({ kind: "success", text: `已载入“${imported.name}”` });
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "无法载入描述文件",
      });
    } finally {
      if (importInputRef.current !== null) importInputRef.current.value = "";
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, serializeSceneDocument(document));
      } catch {
        // Data URL images can exceed browser storage. Export remains available.
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [document]);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), notice.kind === "error" ? 6500 : 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      const targetEditable = isEditableTarget(event.target);
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        exportDocument();
        return;
      }
      if (targetEditable) return;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (command && event.key.toLowerCase() === "d" && selectedElement !== undefined) {
        event.preventDefault();
        duplicate(selectedElement);
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedId !== null) {
        event.preventDefault();
        deleteElement(selectedId);
        return;
      }
      if (
        selectedElement !== undefined &&
        !selectedElement.locked &&
        event.key.startsWith("Arrow")
      ) {
        const amount = event.shiftKey ? document.canvas.gridSize : 1;
        const delta = {
          x: event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0,
          y: event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0,
        };
        if (delta.x !== 0 || delta.y !== 0) {
          event.preventDefault();
          changeElement(moveElementWithinCanvas(selectedElement, delta, document.canvas));
          return;
        }
      }
      const key = event.key.toUpperCase();
      const shortcut = Object.entries(TOOL_SHORTCUTS).find(([, value]) => value === key);
      if (shortcut !== undefined) setTool(shortcut[0] as EditorTool);
      if (key === "I") setImageDialogOpen(true);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    changeElement,
    deleteElement,
    document.canvas,
    duplicate,
    exportDocument,
    redo,
    selectedElement,
    selectedId,
    undo,
  ]);

  const toolHint = useMemo(() => hintForTool(tool), [tool]);

  return (
    <div className="editor-app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Sparkles size={18} />
          </span>
          <span>
            <strong>Scene Draft</strong>
            <small>2D 界面与碰撞编辑器</small>
          </span>
        </div>

        <div className="file-actions">
          <button onClick={newDocument} type="button">
            <RotateCcw size={15} />
            新建
          </button>
          <button onClick={() => importInputRef.current?.click()} type="button">
            <FolderOpen size={15} />
            打开
          </button>
          <button className="primary-action" onClick={exportDocument} type="button">
            <Download size={15} />
            导出 JSON
          </button>
          <input
            accept=".json,.scene.json,application/json"
            className="visually-hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void importDocument(file);
            }}
            ref={importInputRef}
            type="file"
          />
        </div>

        <div className="history-actions">
          <button
            aria-label="撤销"
            className="icon-control"
            disabled={history.past.length === 0}
            onClick={undo}
            title="撤销 · Ctrl/Cmd + Z"
            type="button"
          >
            <Undo2 size={16} />
          </button>
          <button
            aria-label="重做"
            className="icon-control"
            disabled={history.future.length === 0}
            onClick={redo}
            title="重做 · Ctrl/Cmd + Shift + Z"
            type="button"
          >
            <Redo2 size={16} />
          </button>
        </div>

        <div className="scene-title">
          <FileJson size={15} />
          <span title={document.name}>{document.name}</span>
          <small>
            {document.canvas.width} × {document.canvas.height}
          </small>
        </div>

        <div className="view-actions">
          <ToggleButton
            active={showGrid}
            icon={<Grid3X3 size={15} />}
            label="网格"
            onClick={() => setShowGrid((value) => !value)}
          />
          <ToggleButton
            active={snapToGrid}
            icon={<Magnet size={15} />}
            label="吸附"
            onClick={() => setSnapToGrid((value) => !value)}
          />
          <ToggleButton
            active={showCollision}
            icon={<ScanSearch size={15} />}
            label="碰撞区"
            onClick={() => setShowCollision((value) => !value)}
          />
          <label className="zoom-control">
            <span>{Math.round(zoom * 100)}%</span>
            <input
              aria-label="画布缩放"
              max="1.6"
              min="0.25"
              onChange={(event) => setZoom(Number(event.target.value))}
              step="0.05"
              type="range"
              value={zoom}
            />
          </label>
        </div>
      </header>

      <div className="workspace">
        <Sidebar
          elements={document.elements}
          onChange={changeElement}
          onImage={() => setImageDialogOpen(true)}
          onReorder={reorder}
          onSelect={setSelectedId}
          onToolChange={setTool}
          selectedId={selectedId}
          tool={tool}
        />

        <main className="canvas-workspace">
          <div className="canvas-context-bar">
            <span className="active-tool">
              <i />
              {toolHint.title}
            </span>
            <span>{toolHint.detail}</span>
            <button
              className={showLabels ? "label-toggle is-active" : "label-toggle"}
              onClick={() => setShowLabels((value) => !value)}
              type="button"
            >
              {showLabels ? <Check size={13} /> : null}
              元素标注
              <ChevronDown size={12} />
            </button>
          </div>
          <SceneCanvas
            document={document}
            onAdd={addElement}
            onChange={changeElement}
            onPointerPositionChange={setPointerPosition}
            onSelect={setSelectedId}
            onToolChange={setTool}
            selectedId={selectedId}
            showCollision={showCollision}
            showGrid={showGrid}
            showLabels={showLabels}
            snapToGrid={snapToGrid}
            tool={tool}
            zoom={zoom}
          />
          <footer className="statusbar">
            <span>
              {pointerPosition === null
                ? "X —  Y —"
                : `X ${formatCoordinate(pointerPosition.x)}  Y ${formatCoordinate(pointerPosition.y)}`}
            </span>
            <span>左上原点 · X → · Y ↓ · contain 等比缩放</span>
            <span>tabletop.scene/v1 · {document.elements.length} 个对象</span>
          </footer>
        </main>

        <Inspector
          document={document}
          element={selectedElement}
          onChangeDocument={commit}
          onChangeElement={changeElement}
          onDelete={deleteElement}
          onDuplicate={duplicate}
        />
      </div>

      {imageDialogOpen ? (
        <ImageDialog
          onClose={() => setImageDialogOpen(false)}
          onInsert={(source, alt, size) => {
            const element = createImageElement(source, alt, size, document.canvas);
            addElement(element);
            setSelectedId(element.id);
            setTool("select");
            setImageDialogOpen(false);
          }}
        />
      ) : null}

      {notice !== null ? (
        <div className={`notice is-${notice.kind}`} role="status">
          {notice.kind === "success" ? <Check size={16} /> : <X size={16} />}
          <span>{notice.text}</span>
          <button aria-label="关闭提示" onClick={() => setNotice(null)} type="button">
            <X size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ToggleButton({
  active,
  icon,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={active ? "view-toggle is-active" : "view-toggle"}
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
    </button>
  );
}

function ImageDialog({
  onClose,
  onInsert,
}: {
  readonly onClose: () => void;
  readonly onInsert: (
    source: string,
    alt: string,
    size: { readonly width: number; readonly height: number },
  ) => void;
}) {
  const [mode, setMode] = useState<"file" | "url">("url");
  const [source, setSource] = useState("");
  const [alt, setAlt] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const insertUrl = async () => {
    const trimmed = source.trim();
    if (trimmed === "") {
      setError("请输入图片资源链接");
      return;
    }
    setLoading(true);
    const size = await imageSize(trimmed, { width: 400, height: 240 });
    onInsert(trimmed, alt.trim(), size);
  };

  const insertFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("请选择图片文件");
      return;
    }
    if (file.size > 5_000_000) {
      setError("嵌入图片不能超过 5 MB；较大的资源请使用相对 URL");
      return;
    }
    setLoading(true);
    try {
      const dataUrl = await readAsDataUrl(file);
      const size = await imageSize(dataUrl, { width: 400, height: 240 });
      onInsert(dataUrl, alt.trim() || file.name, size);
    } catch {
      setError("无法读取这个图片文件");
      setLoading(false);
    }
  };

  return (
    <div
      aria-label="插入图片"
      aria-modal="true"
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
      role="dialog"
    >
      <section className="image-dialog">
        <header>
          <span className="dialog-icon">
            <ImagePlus size={19} />
          </span>
          <div>
            <strong>插入图片元素</strong>
            <small>资源链接会保存在场景描述文件中</small>
          </div>
          <button aria-label="关闭" className="icon-control" onClick={onClose} type="button">
            <X size={17} />
          </button>
        </header>

        <div className="dialog-tabs">
          <button
            className={mode === "url" ? "is-active" : ""}
            onClick={() => {
              setMode("url");
              setError("");
            }}
            type="button"
          >
            资源 URL
          </button>
          <button
            className={mode === "file" ? "is-active" : ""}
            onClick={() => {
              setMode("file");
              setError("");
            }}
            type="button"
          >
            嵌入本地图片
          </button>
        </div>

        {mode === "url" ? (
          <div className="dialog-body">
            <label className="field">
              <span className="field-label">图片资源链接</span>
              <input
                autoFocus
                onChange={(event) => setSource(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void insertUrl();
                }}
                placeholder="./assets/board-background.png"
                type="text"
                value={source}
              />
            </label>
            <label className="field">
              <span className="field-label">替代文本 / 名称</span>
              <input
                onChange={(event) => setAlt(event.target.value)}
                placeholder="棋盘背景"
                type="text"
                value={alt}
              />
            </label>
            <p className="dialog-help">
              推荐使用相对描述文件的资源链接。编辑器无法预览时仍可插入，并使用默认尺寸。
            </p>
            {error !== "" ? <div className="dialog-error">{error}</div> : null}
            <footer>
              <button onClick={onClose} type="button">
                取消
              </button>
              <button
                className="primary-action"
                disabled={loading}
                onClick={() => void insertUrl()}
                type="button"
              >
                {loading ? "读取中…" : "插入图片"}
              </button>
            </footer>
          </div>
        ) : (
          <div className="dialog-body">
            <label className="file-drop">
              <ImagePlus size={26} />
              <strong>选择一张本地图片</strong>
              <span>图片会编码为 data URL 并写入 JSON，最大 5 MB</span>
              <input
                accept="image/*"
                disabled={loading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) void insertFile(file);
                }}
                type="file"
              />
            </label>
            {error !== "" ? <div className="dialog-error">{error}</div> : null}
            <p className="dialog-help">
              大型或需要缓存的游戏素材应放进游戏资源目录，并通过“资源 URL”引用。
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function loadInitialHistory(): EditorHistory {
  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY);
    if (saved !== null) {
      return { past: [], present: parseSceneJson(saved), future: [] };
    }
  } catch {
    // Browser storage is optional.
  }
  return { past: [], present: createEmptyScene(), future: [] };
}

function hintForTool(tool: EditorTool): { readonly title: string; readonly detail: string } {
  switch (tool) {
    case "select":
      return { title: "选择工具", detail: "拖动移动，右下控制点缩放" };
    case "rectangle":
      return { title: "矩形工具", detail: "在画布上拖动绘制矩形" };
    case "ellipse":
      return { title: "椭圆工具", detail: "在画布上拖动绘制椭圆" };
    case "line":
      return { title: "直线工具", detail: "从起点拖动到终点" };
    case "arrow":
      return { title: "箭头工具", detail: "从起点拖动到终点" };
    case "freehand":
      return { title: "自由线工具", detail: "按住并拖动绘制曲线" };
    case "polyline":
      return { title: "折线工具", detail: "逐点单击，双击或 Enter 完成" };
    case "polygon":
      return { title: "多边形工具", detail: "逐点单击，点回首点或 Enter 闭合" };
    case "text":
      return { title: "文字标注", detail: "单击画布放置文字" };
  }
}

function safeFileName(name: string): string {
  const value = name
    .trim()
    .replace(/[^\p{Letter}\p{Number}_.-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return value === "" ? "scene" : value;
}

function formatCoordinate(value: number): string {
  return Number(value.toFixed(1)).toString().padStart(5, " ");
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function imageSize(
  source: string,
  fallback: { readonly width: number; readonly height: number },
): Promise<{ readonly width: number; readonly height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (size: { readonly width: number; readonly height: number }) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(size);
    };
    const timer = window.setTimeout(() => finish(fallback), 3000);
    image.onload = () =>
      finish({
        width: Math.max(1, image.naturalWidth),
        height: Math.max(1, image.naturalHeight),
      });
    image.onerror = () => finish(fallback);
    image.src = source;
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("读取失败"));
    reader.onerror = () => reject(reader.error ?? new Error("读取失败"));
    reader.readAsDataURL(file);
  });
}
