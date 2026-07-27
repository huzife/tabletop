import {
  SCENE_FORMAT,
  SCENE_FORMAT_VERSION,
  elementBounds,
  translateElement,
  type FreehandElement,
  type PolylineElement,
  type SceneBounds,
  type SceneDocument,
  type SceneElement,
  type SceneElementRole,
  type SceneMetadata,
  type ScenePoint,
  type SceneStyle,
} from "@tabletop/scene";

export type EditorTool =
  | "select"
  | "rectangle"
  | "ellipse"
  | "line"
  | "arrow"
  | "polyline"
  | "polygon"
  | "freehand"
  | "text";

export const TOOL_SHORTCUTS: Readonly<Record<EditorTool, string>> = {
  select: "V",
  rectangle: "R",
  ellipse: "O",
  line: "L",
  arrow: "A",
  polyline: "P",
  polygon: "G",
  freehand: "B",
  text: "T",
};

const DEFAULT_STYLE: SceneStyle = {
  fill: "#5b6ff5",
  fillOpacity: 0.18,
  stroke: "#4353c7",
  strokeOpacity: 1,
  strokeWidth: 2,
  dash: [],
  lineCap: "round",
  lineJoin: "round",
};

const EMPTY_METADATA: SceneMetadata = {
  label: "",
  notes: "",
  tags: [],
};

export function createEmptyScene(): SceneDocument {
  return {
    format: SCENE_FORMAT,
    formatVersion: SCENE_FORMAT_VERSION,
    name: "未命名场景",
    canvas: {
      width: 1280,
      height: 720,
      background: "#f8fafc",
      gridSize: 20,
      coordinateSystem: {
        origin: "top-left",
        xAxis: "right",
        yAxis: "down",
        unit: "scene-unit",
      },
      scaleMode: "contain",
    },
    elements: [],
  };
}

export function createElementFromDrag(
  tool: Extract<EditorTool, "arrow" | "ellipse" | "line" | "rectangle">,
  start: ScenePoint,
  end: ScenePoint,
  id = createElementId(),
): SceneElement {
  const frame = frameFromPoints(start, end);
  const base = createBase(id, defaultName(tool));
  switch (tool) {
    case "rectangle":
      return {
        ...base,
        type: "rectangle",
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        cornerRadius: 12,
      };
    case "ellipse":
      return {
        ...base,
        type: "ellipse",
        cx: frame.x + frame.width / 2,
        cy: frame.y + frame.height / 2,
        rx: frame.width / 2,
        ry: frame.height / 2,
      };
    case "line":
    case "arrow":
      return {
        ...base,
        name: defaultName(tool),
        type: "line",
        style: { ...base.style, fill: "none", fillOpacity: 0 },
        start,
        end,
        arrowStart: false,
        arrowEnd: tool === "arrow",
      };
  }
}

export function createFreehandElement(
  points: readonly ScenePoint[],
  id = createElementId(),
): FreehandElement {
  const safePoints = ensureTwoPoints(points);
  return {
    ...createBase(id, "自由线"),
    type: "freehand",
    style: { ...DEFAULT_STYLE, fill: "none", fillOpacity: 0, strokeWidth: 3 },
    points: safePoints,
    smoothing: 0.55,
  };
}

export function createPolylineElement(
  points: readonly ScenePoint[],
  closed: boolean,
  id = createElementId(),
): PolylineElement {
  return {
    ...createBase(id, closed ? "多边形" : "折线"),
    type: "polyline",
    style: closed ? { ...DEFAULT_STYLE } : { ...DEFAULT_STYLE, fill: "none", fillOpacity: 0 },
    points: ensureTwoPoints(points),
    closed,
  };
}

export function createTextElement(point: ScenePoint, id = createElementId()): SceneElement {
  return {
    ...createBase(id, "文字标注"),
    type: "text",
    x: point.x,
    y: point.y,
    text: "双击或在右侧编辑标注",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 24,
    fontWeight: "semibold",
    lineHeight: 1.3,
    align: "left",
    maxWidth: 360,
    style: {
      ...DEFAULT_STYLE,
      fill: "#172033",
      fillOpacity: 1,
      stroke: "none",
      strokeOpacity: 0,
      strokeWidth: 0,
    },
  };
}

export function createImageElement(
  source: string,
  alt: string,
  size: { readonly width: number; readonly height: number },
  canvas: Pick<SceneDocument["canvas"], "height" | "width">,
  id = createElementId(),
): SceneElement {
  const maximumWidth = Math.min(520, canvas.width * 0.7);
  const maximumHeight = Math.min(360, canvas.height * 0.7);
  const scale = Math.min(
    1,
    maximumWidth / Math.max(1, size.width),
    maximumHeight / Math.max(1, size.height),
  );
  const width = Math.max(40, size.width * scale);
  const height = Math.max(40, size.height * scale);
  return {
    ...createBase(id, alt.trim() || "图片"),
    type: "image",
    x: (canvas.width - width) / 2,
    y: (canvas.height - height) / 2,
    width,
    height,
    source,
    alt,
    fit: "contain",
    style: {
      ...DEFAULT_STYLE,
      fill: "none",
      fillOpacity: 0,
      stroke: "#94a3b8",
      strokeOpacity: 0.8,
      strokeWidth: 1,
    },
  };
}

export function duplicateElement(element: SceneElement): SceneElement {
  return {
    ...translateElement(element, { x: 16, y: 16 }),
    id: createElementId(),
    name: `${element.name} 副本`,
    metadata: {
      ...element.metadata,
      tags: [...element.metadata.tags],
    },
    style: {
      ...element.style,
      dash: [...element.style.dash],
    },
  };
}

export function setElementRole(element: SceneElement, role: SceneElementRole): SceneElement {
  return { ...element, role };
}

export function moveElementWithinCanvas(
  element: SceneElement,
  delta: ScenePoint,
  canvas: Pick<SceneDocument["canvas"], "height" | "width">,
): SceneElement {
  const translated = translateElement(element, delta);
  const bounds = elementBounds(translated);
  const correction = {
    x:
      bounds.x < 0
        ? -bounds.x
        : bounds.x + bounds.width > canvas.width
          ? canvas.width - (bounds.x + bounds.width)
          : 0,
    y:
      bounds.y < 0
        ? -bounds.y
        : bounds.y + bounds.height > canvas.height
          ? canvas.height - (bounds.y + bounds.height)
          : 0,
  };
  return translateElement(translated, correction);
}

export function frameFromPoints(start: ScenePoint, end: ScenePoint): SceneBounds {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.max(1, Math.abs(end.x - start.x)),
    height: Math.max(1, Math.abs(end.y - start.y)),
  };
}

export function snapPoint(point: ScenePoint, gridSize: number, enabled: boolean): ScenePoint {
  if (!enabled) return point;
  return {
    x: Math.round(point.x / gridSize) * gridSize,
    y: Math.round(point.y / gridSize) * gridSize,
  };
}

export function replaceElement(
  elements: readonly SceneElement[],
  next: SceneElement,
): SceneElement[] {
  return elements.map((element) => (element.id === next.id ? next : element));
}

export function createElementId(): string {
  return `element-${crypto.randomUUID()}`;
}

export function elementTypeLabel(element: SceneElement): string {
  switch (element.type) {
    case "rectangle":
      return "矩形";
    case "ellipse":
      return "椭圆";
    case "line":
      return element.arrowStart || element.arrowEnd ? "箭头" : "直线";
    case "polyline":
      return element.closed ? "多边形" : "折线";
    case "freehand":
      return "自由线";
    case "text":
      return "文字";
    case "image":
      return "图片";
  }
}

export function roleLabel(role: SceneElementRole): string {
  switch (role) {
    case "visual":
      return "视觉";
    case "collision":
      return "碰撞";
    case "both":
      return "视觉 + 碰撞";
  }
}

function createBase(id: string, name: string) {
  return {
    id,
    name,
    role: "visual" as const,
    visible: true,
    locked: false,
    opacity: 1,
    rotation: 0,
    style: { ...DEFAULT_STYLE, dash: [...DEFAULT_STYLE.dash] },
    metadata: { ...EMPTY_METADATA, tags: [...EMPTY_METADATA.tags] },
  };
}

function defaultName(tool: EditorTool): string {
  switch (tool) {
    case "rectangle":
      return "矩形";
    case "ellipse":
      return "椭圆";
    case "line":
      return "直线";
    case "arrow":
      return "箭头";
    case "polyline":
      return "折线";
    case "polygon":
      return "多边形";
    case "freehand":
      return "自由线";
    case "text":
      return "文字标注";
    case "select":
      return "元素";
  }
}

function ensureTwoPoints(points: readonly ScenePoint[]): [ScenePoint, ScenePoint, ...ScenePoint[]] {
  const first = points[0] ?? { x: 0, y: 0 };
  const second = points[1] ?? { x: first.x + 1, y: first.y + 1 };
  return [first, second, ...points.slice(2)];
}
