import {
  elementBounds,
  elementCenter,
  pointsToSmoothSvgPath,
  resizeElement,
  type SceneDocument,
  type SceneElement,
  type ScenePoint,
} from "@tabletop/scene";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createElementFromDrag,
  createFreehandElement,
  createPolylineElement,
  createTextElement,
  frameFromPoints,
  moveElementWithinCanvas,
  snapPoint,
  type EditorTool,
} from "./editor-model";

interface SceneCanvasProps {
  readonly document: SceneDocument;
  readonly selectedId: string | null;
  readonly tool: EditorTool;
  readonly snapToGrid: boolean;
  readonly showGrid: boolean;
  readonly showCollision: boolean;
  readonly showLabels: boolean;
  readonly zoom: number;
  readonly onAdd: (element: SceneElement) => void;
  readonly onChange: (element: SceneElement) => void;
  readonly onPointerPositionChange: (point: ScenePoint | null) => void;
  readonly onSelect: (id: string | null) => void;
  readonly onToolChange: (tool: EditorTool) => void;
}

type Gesture =
  | {
      readonly kind: "draw";
      readonly tool: Extract<EditorTool, "arrow" | "ellipse" | "line" | "rectangle">;
      readonly start: ScenePoint;
      readonly current: ScenePoint;
    }
  | {
      readonly kind: "freehand";
      readonly points: readonly ScenePoint[];
    }
  | {
      readonly kind: "move";
      readonly start: ScenePoint;
      readonly original: SceneElement;
      readonly current: SceneElement;
    }
  | {
      readonly kind: "resize";
      readonly start: ScenePoint;
      readonly original: SceneElement;
      readonly current: SceneElement;
    };

interface PolyDraft {
  readonly closed: boolean;
  readonly points: readonly ScenePoint[];
  readonly hover: ScenePoint;
}

export function SceneCanvas({
  document,
  selectedId,
  tool,
  snapToGrid,
  showGrid,
  showCollision,
  showLabels,
  zoom,
  onAdd,
  onChange,
  onPointerPositionChange,
  onSelect,
  onToolChange,
}: SceneCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [polyDraft, setPolyDraft] = useState<PolyDraft | null>(null);
  const selected = document.elements.find((element) => element.id === selectedId);

  const finishPolyline = useCallback(() => {
    if (polyDraft === null) return;
    const points = removeConsecutiveDuplicates(polyDraft.points);
    const minimum = polyDraft.closed ? 3 : 2;
    if (points.length >= minimum) {
      const element = createPolylineElement(points, polyDraft.closed);
      onAdd(element);
      onSelect(element.id);
      onToolChange("select");
    }
    setPolyDraft(null);
  }, [onAdd, onSelect, onToolChange, polyDraft]);

  useEffect(() => {
    if (tool !== "polyline" && tool !== "polygon") setPolyDraft(null);
  }, [tool]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (polyDraft === null) return;
      if (event.key === "Enter") {
        event.preventDefault();
        finishPolyline();
      } else if (event.key === "Escape") {
        event.preventDefault();
        setPolyDraft(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finishPolyline, polyDraft]);

  const previewElement = useMemo((): SceneElement | null => {
    if (gesture === null) return null;
    switch (gesture.kind) {
      case "draw":
        return createElementFromDrag(gesture.tool, gesture.start, gesture.current, "draft");
      case "freehand":
        return createFreehandElement(gesture.points, "draft");
      case "move":
      case "resize":
        return gesture.current;
    }
  }, [gesture]);

  const visibleElements = useMemo(() => {
    if (previewElement === null) return document.elements;
    if (gesture?.kind === "move" || gesture?.kind === "resize") {
      return document.elements.map((element) =>
        element.id === previewElement.id ? previewElement : element,
      );
    }
    return [...document.elements, previewElement];
  }, [document.elements, gesture?.kind, previewElement]);

  const pointerPoint = useCallback(
    (event: React.PointerEvent<SVGSVGElement | SVGGElement | SVGCircleElement>) => {
      const svg = svgRef.current;
      if (svg === null) return { x: 0, y: 0 };
      const matrix = svg.getScreenCTM();
      if (matrix === null) return { x: 0, y: 0 };
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      return {
        x: clamp(point.x, 0, document.canvas.width),
        y: clamp(point.y, 0, document.canvas.height),
      };
    },
    [document.canvas.height, document.canvas.width],
  );

  const snappedPointerPoint = useCallback(
    (event: React.PointerEvent<SVGSVGElement | SVGGElement | SVGCircleElement>) =>
      snapPoint(pointerPoint(event), document.canvas.gridSize, snapToGrid && !event.altKey),
    [document.canvas.gridSize, pointerPoint, snapToGrid],
  );

  const capturePointer = (pointerId: number) => {
    svgRef.current?.setPointerCapture(pointerId);
  };

  const handleCanvasPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const point = snappedPointerPoint(event);
    if (tool === "select") {
      onSelect(null);
      return;
    }
    if (tool === "text") {
      const element = createTextElement(point);
      onAdd(element);
      onSelect(element.id);
      onToolChange("select");
      return;
    }
    if (tool === "polyline" || tool === "polygon") {
      const closed = tool === "polygon";
      if (
        polyDraft !== null &&
        closed &&
        polyDraft.points.length >= 3 &&
        distance(point, polyDraft.points[0] ?? point) <= document.canvas.gridSize * 0.6
      ) {
        finishPolyline();
        return;
      }
      setPolyDraft((current) => ({
        closed,
        points: [...(current?.points ?? []), point],
        hover: point,
      }));
      return;
    }
    capturePointer(event.pointerId);
    if (tool === "freehand") {
      setGesture({ kind: "freehand", points: [point, point] });
      return;
    }
    setGesture({ kind: "draw", tool, start: point, current: point });
  };

  const handleElementPointerDown = (
    event: React.PointerEvent<SVGGElement>,
    element: SceneElement,
  ) => {
    if (tool !== "select") return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(element.id);
    if (element.locked) return;
    capturePointer(event.pointerId);
    setGesture({
      kind: "move",
      start: snappedPointerPoint(event),
      original: element,
      current: element,
    });
  };

  const handleResizePointerDown = (
    event: React.PointerEvent<SVGCircleElement>,
    element: SceneElement,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (element.locked) return;
    capturePointer(event.pointerId);
    setGesture({
      kind: "resize",
      start: snappedPointerPoint(event),
      original: element,
      current: element,
    });
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const raw = pointerPoint(event);
    onPointerPositionChange(raw);
    const point = snapPoint(raw, document.canvas.gridSize, snapToGrid && !event.altKey);
    if (polyDraft !== null) {
      setPolyDraft((current) => (current === null ? null : { ...current, hover: point }));
    }
    if (gesture === null) return;

    switch (gesture.kind) {
      case "draw":
        setGesture({ ...gesture, current: point });
        break;
      case "freehand": {
        const previous = gesture.points.at(-1) ?? point;
        if (distance(previous, raw) >= Math.max(1, document.canvas.gridSize / 8)) {
          setGesture({ ...gesture, points: [...gesture.points, raw] });
        }
        break;
      }
      case "move": {
        const delta = { x: point.x - gesture.start.x, y: point.y - gesture.start.y };
        setGesture({
          ...gesture,
          current: moveElementWithinCanvas(gesture.original, delta, document.canvas),
        });
        break;
      }
      case "resize": {
        const bounds = elementBounds(gesture.original);
        const nextBounds = {
          x: bounds.x,
          y: bounds.y,
          width: Math.max(1, point.x - bounds.x),
          height: Math.max(1, point.y - bounds.y),
        };
        setGesture({
          ...gesture,
          current: resizeElement(gesture.original, bounds, nextBounds),
        });
        break;
      }
    }
  };

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (gesture === null) return;
    if (svgRef.current?.hasPointerCapture(event.pointerId) === true) {
      svgRef.current.releasePointerCapture(event.pointerId);
    }

    switch (gesture.kind) {
      case "draw": {
        const frame = frameFromPoints(gesture.start, gesture.current);
        if (
          gesture.tool === "line" ||
          gesture.tool === "arrow" ||
          frame.width >= 2 ||
          frame.height >= 2
        ) {
          const element = createElementFromDrag(gesture.tool, gesture.start, gesture.current);
          onAdd(element);
          onSelect(element.id);
          onToolChange("select");
        }
        break;
      }
      case "freehand": {
        if (gesture.points.length >= 2) {
          const element = createFreehandElement(gesture.points);
          onAdd(element);
          onSelect(element.id);
          onToolChange("select");
        }
        break;
      }
      case "move":
      case "resize":
        onChange(gesture.current);
        break;
    }
    setGesture(null);
  };

  const handleDoubleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    if (polyDraft === null) return;
    event.preventDefault();
    finishPolyline();
  };

  const grid = document.canvas.gridSize;
  const cursor = cursorForTool(tool, gesture);
  const artboardWidth = document.canvas.width * zoom;
  const artboardHeight = document.canvas.height * zoom;

  return (
    <div className="canvas-scroll">
      <div className="artboard-shell" style={{ width: artboardWidth, height: artboardHeight }}>
        <svg
          aria-label="场景画布"
          className="scene-canvas"
          onDoubleClick={handleDoubleClick}
          onPointerCancel={() => setGesture(null)}
          onPointerDown={handleCanvasPointerDown}
          onPointerLeave={() => onPointerPositionChange(null)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          preserveAspectRatio="xMidYMid meet"
          ref={svgRef}
          style={{ cursor }}
          viewBox={`0 0 ${document.canvas.width} ${document.canvas.height}`}
        >
          <defs>
            <pattern height={grid} id="minor-grid" patternUnits="userSpaceOnUse" width={grid}>
              <path className="grid-minor" d={`M ${grid} 0 L 0 0 0 ${grid}`} fill="none" />
            </pattern>
            <pattern
              height={grid * 5}
              id="major-grid"
              patternUnits="userSpaceOnUse"
              width={grid * 5}
            >
              <rect fill="url(#minor-grid)" height="100%" width="100%" />
              <path className="grid-major" d={`M ${grid * 5} 0 L 0 0 0 ${grid * 5}`} fill="none" />
            </pattern>
            <clipPath id="canvas-clip">
              <rect height={document.canvas.height} width={document.canvas.width} />
            </clipPath>
          </defs>

          <rect
            fill={document.canvas.background}
            height={document.canvas.height}
            width={document.canvas.width}
          />
          {showGrid ? (
            <rect
              fill="url(#major-grid)"
              height={document.canvas.height}
              pointerEvents="none"
              width={document.canvas.width}
            />
          ) : null}

          <g clipPath="url(#canvas-clip)">
            {visibleElements.map((element) => (
              <SceneElementSvg
                element={element}
                key={element.id}
                onPointerDown={handleElementPointerDown}
                preview={element.id === "draft"}
                selected={element.id === selectedId}
                showCollision={showCollision}
              />
            ))}

            {polyDraft !== null ? (
              <PolylineDraft
                closed={polyDraft.closed}
                hover={polyDraft.hover}
                points={polyDraft.points}
              />
            ) : null}

            {showLabels
              ? visibleElements.map((element) => (
                  <ElementLabel element={element} key={`label-${element.id}`} />
                ))
              : null}
          </g>

          {selected !== undefined ? (
            <SelectionOutline
              element={previewElement?.id === selected.id ? previewElement : selected}
              onResizePointerDown={handleResizePointerDown}
            />
          ) : null}

          {document.elements.length === 0 && gesture === null && polyDraft === null ? (
            <g className="canvas-empty" pointerEvents="none">
              <circle
                cx={document.canvas.width / 2}
                cy={document.canvas.height / 2 - 28}
                fill="none"
                r="34"
                stroke="currentColor"
                strokeDasharray="6 6"
                strokeWidth="2"
              />
              <text
                dominantBaseline="middle"
                textAnchor="middle"
                x={document.canvas.width / 2}
                y={document.canvas.height / 2 - 28}
              >
                ＋
              </text>
              <text
                className="canvas-empty__title"
                textAnchor="middle"
                x={document.canvas.width / 2}
                y={document.canvas.height / 2 + 42}
              >
                从左侧选择工具开始绘制
              </text>
              <text
                className="canvas-empty__hint"
                textAnchor="middle"
                x={document.canvas.width / 2}
                y={document.canvas.height / 2 + 70}
              >
                所有坐标都会原样写入场景描述文件
              </text>
            </g>
          ) : null}
        </svg>
      </div>
    </div>
  );
}

interface SceneElementSvgProps {
  readonly element: SceneElement;
  readonly selected: boolean;
  readonly preview: boolean;
  readonly showCollision: boolean;
  readonly onPointerDown: (event: React.PointerEvent<SVGGElement>, element: SceneElement) => void;
}

function SceneElementSvg({
  element,
  selected,
  preview,
  showCollision,
  onPointerDown,
}: SceneElementSvgProps) {
  if (!element.visible && !selected) return null;
  const center = elementCenter(element);
  const transform =
    element.rotation === 0 ? undefined : `rotate(${element.rotation} ${center.x} ${center.y})`;
  const showVisual = element.role !== "collision";
  const showCollisionShape = showCollision && element.role !== "visual";

  return (
    <g
      className={[
        "scene-element",
        selected ? "is-selected" : "",
        preview ? "is-preview" : "",
        element.locked ? "is-locked" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-element-id={element.id}
      onPointerDown={(event) => onPointerDown(event, element)}
      opacity={element.visible ? element.opacity : 0.22}
      transform={transform}
    >
      {showVisual ? <ElementGeometry element={element} mode="visual" /> : null}
      {showCollisionShape ? <ElementGeometry element={element} mode="collision" /> : null}
      <ElementGeometry element={element} mode="hit-target" />
    </g>
  );
}

function ElementGeometry({
  element,
  mode,
}: {
  readonly element: SceneElement;
  readonly mode: "collision" | "hit-target" | "visual";
}) {
  const style = geometryStyle(element, mode);
  switch (element.type) {
    case "rectangle":
      return (
        <rect
          height={element.height}
          rx={Math.min(element.cornerRadius, element.width / 2, element.height / 2)}
          width={element.width}
          x={element.x}
          y={element.y}
          {...style}
        />
      );
    case "ellipse":
      return <ellipse cx={element.cx} cy={element.cy} rx={element.rx} ry={element.ry} {...style} />;
    case "line":
      return (
        <>
          <line
            x1={element.start.x}
            x2={element.end.x}
            y1={element.start.y}
            y2={element.end.y}
            {...style}
          />
          {mode !== "hit-target" && element.arrowStart ? (
            <polygon
              fill={mode === "collision" ? "#ef4444" : element.style.stroke}
              points={arrowPoints(element.end, element.start, element.style.strokeWidth)}
              pointerEvents="none"
            />
          ) : null}
          {mode !== "hit-target" && element.arrowEnd ? (
            <polygon
              fill={mode === "collision" ? "#ef4444" : element.style.stroke}
              points={arrowPoints(element.start, element.end, element.style.strokeWidth)}
              pointerEvents="none"
            />
          ) : null}
        </>
      );
    case "polyline": {
      const points = element.points.map((point) => `${point.x},${point.y}`).join(" ");
      return element.closed ? (
        <polygon points={points} {...style} />
      ) : (
        <polyline points={points} {...style} />
      );
    }
    case "freehand":
      return <path d={pointsToSmoothSvgPath(element.points, element.smoothing)} {...style} />;
    case "text": {
      if (mode === "collision") {
        const bounds = elementBounds(element);
        return (
          <rect height={bounds.height} width={bounds.width} x={bounds.x} y={bounds.y} {...style} />
        );
      }
      if (mode === "hit-target") {
        const bounds = elementBounds(element);
        return (
          <rect
            fill="transparent"
            height={bounds.height}
            pointerEvents="all"
            stroke="transparent"
            width={bounds.width}
            x={bounds.x}
            y={bounds.y}
          />
        );
      }
      const anchor =
        element.align === "center" ? "middle" : element.align === "right" ? "end" : "start";
      return (
        <text
          dominantBaseline="hanging"
          fill={element.style.fill}
          fillOpacity={element.style.fillOpacity}
          fontFamily={element.fontFamily}
          fontSize={element.fontSize}
          fontWeight={fontWeight(element.fontWeight)}
          pointerEvents="none"
          textAnchor={anchor}
          x={element.x}
          y={element.y}
        >
          {element.text.split("\n").map((line, index) => (
            <tspan
              dy={index === 0 ? 0 : element.fontSize * element.lineHeight}
              key={`${index}-${line}`}
              x={element.x}
            >
              {line || " "}
            </tspan>
          ))}
        </text>
      );
    }
    case "image": {
      if (mode === "collision") {
        return (
          <rect
            height={element.height}
            width={element.width}
            x={element.x}
            y={element.y}
            {...style}
          />
        );
      }
      if (mode === "hit-target") {
        return (
          <rect
            fill="transparent"
            height={element.height}
            pointerEvents="all"
            stroke="transparent"
            width={element.width}
            x={element.x}
            y={element.y}
          />
        );
      }
      return (
        <>
          <rect
            fill="#e2e8f0"
            height={element.height}
            width={element.width}
            x={element.x}
            y={element.y}
          />
          <image
            aria-label={element.alt}
            height={element.height}
            href={element.source}
            preserveAspectRatio={
              element.fit === "fill"
                ? "none"
                : element.fit === "cover"
                  ? "xMidYMid slice"
                  : "xMidYMid meet"
            }
            width={element.width}
            x={element.x}
            y={element.y}
          />
          {element.style.strokeWidth > 0 ? (
            <rect
              fill="none"
              height={element.height}
              stroke={element.style.stroke}
              strokeOpacity={element.style.strokeOpacity}
              strokeWidth={element.style.strokeWidth}
              width={element.width}
              x={element.x}
              y={element.y}
            />
          ) : null}
        </>
      );
    }
  }
}

function SelectionOutline({
  element,
  onResizePointerDown,
}: {
  readonly element: SceneElement;
  readonly onResizePointerDown: (
    event: React.PointerEvent<SVGCircleElement>,
    element: SceneElement,
  ) => void;
}) {
  const bounds = elementBounds(element);
  const center = elementCenter(element);
  const transform =
    element.rotation === 0 ? undefined : `rotate(${element.rotation} ${center.x} ${center.y})`;
  return (
    <g className="selection-outline" pointerEvents="none" transform={transform}>
      <rect
        fill="none"
        height={Math.max(1, bounds.height)}
        stroke="currentColor"
        strokeDasharray="5 4"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        width={Math.max(1, bounds.width)}
        x={bounds.x}
        y={bounds.y}
      />
      {!element.locked ? (
        <circle
          aria-label="调整元素尺寸"
          className="resize-handle"
          cx={bounds.x + bounds.width}
          cy={bounds.y + bounds.height}
          onPointerDown={(event) => onResizePointerDown(event, element)}
          pointerEvents="all"
          r="6"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </g>
  );
}

function PolylineDraft({
  closed,
  hover,
  points,
}: {
  readonly closed: boolean;
  readonly hover: ScenePoint;
  readonly points: readonly ScenePoint[];
}) {
  const displayPoints = [...points, hover];
  return (
    <g className="poly-draft" pointerEvents="none">
      {closed ? (
        <polygon
          fill="rgb(91 111 245 / 12%)"
          points={displayPoints.map((point) => `${point.x},${point.y}`).join(" ")}
          stroke="currentColor"
          strokeDasharray="7 5"
          strokeWidth="2"
        />
      ) : (
        <polyline
          fill="none"
          points={displayPoints.map((point) => `${point.x},${point.y}`).join(" ")}
          stroke="currentColor"
          strokeDasharray="7 5"
          strokeWidth="2"
        />
      )}
      {points.map((point, index) => (
        <circle
          cx={point.x}
          cy={point.y}
          fill={index === 0 ? "#5b6ff5" : "#ffffff"}
          key={`${point.x}-${point.y}-${index}`}
          r={index === 0 && closed ? 7 : 4}
          stroke="#5b6ff5"
          strokeWidth="2"
        />
      ))}
    </g>
  );
}

function ElementLabel({ element }: { readonly element: SceneElement }) {
  const label = element.metadata.label.trim();
  if (!element.visible || label === "") return null;
  const bounds = elementBounds(element);
  const width = Math.max(44, label.length * 12 + 18);
  const x = clamp(bounds.x, 4, Number.MAX_SAFE_INTEGER);
  const y = Math.max(4, bounds.y - 28);
  return (
    <g className="element-label" pointerEvents="none">
      <rect height="22" rx="6" width={width} x={x} y={y} />
      <text dominantBaseline="middle" x={x + 9} y={y + 11}>
        {label}
      </text>
    </g>
  );
}

function geometryStyle(element: SceneElement, mode: "collision" | "hit-target" | "visual") {
  if (mode === "hit-target") {
    return {
      fill: element.type === "line" || element.type === "freehand" ? "none" : "transparent",
      pointerEvents: "all" as const,
      stroke: "transparent",
      strokeWidth: Math.max(12, element.style.strokeWidth),
    };
  }
  if (mode === "collision") {
    return {
      fill:
        element.type === "line" || element.type === "freehand" || !isClosedGeometry(element)
          ? "none"
          : "#ef4444",
      fillOpacity: 0.16,
      pointerEvents: "none" as const,
      stroke: "#ef4444",
      strokeDasharray: "8 5",
      strokeWidth: Math.max(2, element.style.strokeWidth),
      vectorEffect: "non-scaling-stroke" as const,
    };
  }
  return {
    fill:
      element.type === "line" || element.type === "freehand" || !isClosedGeometry(element)
        ? "none"
        : element.style.fill,
    fillOpacity: element.style.fillOpacity,
    pointerEvents: "none" as const,
    stroke: element.style.stroke,
    strokeDasharray: element.style.dash.join(" "),
    strokeLinecap: element.style.lineCap,
    strokeLinejoin: element.style.lineJoin,
    strokeOpacity: element.style.strokeOpacity,
    strokeWidth: element.style.strokeWidth,
  };
}

function isClosedGeometry(element: SceneElement): boolean {
  return element.type !== "polyline" || element.closed;
}

function arrowPoints(from: ScenePoint, to: ScenePoint, strokeWidth: number): string {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = Math.max(9, strokeWidth * 3.2);
  return [
    to,
    {
      x: to.x - Math.cos(angle - Math.PI / 6) * size,
      y: to.y - Math.sin(angle - Math.PI / 6) * size,
    },
    {
      x: to.x - Math.cos(angle + Math.PI / 6) * size,
      y: to.y - Math.sin(angle + Math.PI / 6) * size,
    },
  ]
    .map((point) => `${point.x},${point.y}`)
    .join(" ");
}

function fontWeight(value: Extract<SceneElement, { type: "text" }>["fontWeight"]): number | string {
  switch (value) {
    case "medium":
      return 500;
    case "semibold":
      return 600;
    case "bold":
      return 700;
    case "normal":
      return "normal";
  }
}

function cursorForTool(tool: EditorTool, gesture: Gesture | null): string {
  if (gesture?.kind === "move") return "grabbing";
  switch (tool) {
    case "select":
      return "default";
    case "text":
      return "text";
    case "freehand":
      return "crosshair";
    default:
      return "crosshair";
  }
}

function removeConsecutiveDuplicates(points: readonly ScenePoint[]): ScenePoint[] {
  const output: ScenePoint[] = [];
  for (const point of points) {
    const previous = output.at(-1);
    if (previous === undefined || distance(previous, point) > 1) output.push(point);
  }
  return output;
}

function distance(first: ScenePoint, second: ScenePoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
