import type {
  EllipseElement,
  FreehandElement,
  PolylineElement,
  RectangleElement,
  SceneDocument,
  SceneElement,
  SceneElementRole,
  ScenePoint,
} from "./schema.js";
import { sampleSmoothPoints } from "./path.js";

export interface SceneBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface HitTestOptions {
  readonly roles?: readonly SceneElementRole[];
  readonly tolerance?: number;
  readonly includeInvisible?: boolean;
}

export function elementBounds(element: SceneElement): SceneBounds {
  switch (element.type) {
    case "rectangle":
    case "image":
      return {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      };
    case "ellipse":
      return {
        x: element.cx - element.rx,
        y: element.cy - element.ry,
        width: element.rx * 2,
        height: element.ry * 2,
      };
    case "line":
      return boundsFromPoints([element.start, element.end]);
    case "polyline":
    case "freehand":
      return boundsFromPoints(element.points);
    case "text": {
      const lines = element.text.split("\n");
      const longestLine = Math.max(1, ...lines.map((line) => line.length));
      const estimatedWidth = Math.min(element.maxWidth, longestLine * element.fontSize * 0.62);
      const x =
        element.align === "center"
          ? element.x - estimatedWidth / 2
          : element.align === "right"
            ? element.x - estimatedWidth
            : element.x;
      return {
        x,
        y: element.y,
        width: Math.max(1, estimatedWidth),
        height: Math.max(element.fontSize, lines.length * element.fontSize * element.lineHeight),
      };
    }
  }
}

export function elementCenter(element: SceneElement): ScenePoint {
  const bounds = elementBounds(element);
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

export function translateElement(element: SceneElement, delta: Readonly<ScenePoint>): SceneElement {
  switch (element.type) {
    case "rectangle":
    case "image":
      return { ...element, x: element.x + delta.x, y: element.y + delta.y };
    case "ellipse":
      return { ...element, cx: element.cx + delta.x, cy: element.cy + delta.y };
    case "line":
      return {
        ...element,
        start: { x: element.start.x + delta.x, y: element.start.y + delta.y },
        end: { x: element.end.x + delta.x, y: element.end.y + delta.y },
      };
    case "polyline":
    case "freehand":
      return {
        ...element,
        points: element.points.map((point) => ({
          x: point.x + delta.x,
          y: point.y + delta.y,
        })),
      };
    case "text":
      return { ...element, x: element.x + delta.x, y: element.y + delta.y };
  }
}

export function resizeElement(
  element: SceneElement,
  original: SceneBounds,
  next: SceneBounds,
): SceneElement {
  const safeWidth = Math.max(1, next.width);
  const safeHeight = Math.max(1, next.height);
  const scaleX = safeWidth / Math.max(1, original.width);
  const scaleY = safeHeight / Math.max(1, original.height);
  const mapPoint = (point: ScenePoint): ScenePoint => ({
    x: next.x + (point.x - original.x) * scaleX,
    y: next.y + (point.y - original.y) * scaleY,
  });

  switch (element.type) {
    case "rectangle":
      return {
        ...element,
        x: next.x,
        y: next.y,
        width: safeWidth,
        height: safeHeight,
        cornerRadius: Math.min(
          element.cornerRadius * Math.min(scaleX, scaleY),
          safeWidth / 2,
          safeHeight / 2,
        ),
      };
    case "image":
      return { ...element, x: next.x, y: next.y, width: safeWidth, height: safeHeight };
    case "ellipse":
      return {
        ...element,
        cx: next.x + safeWidth / 2,
        cy: next.y + safeHeight / 2,
        rx: safeWidth / 2,
        ry: safeHeight / 2,
      };
    case "line":
      return { ...element, start: mapPoint(element.start), end: mapPoint(element.end) };
    case "polyline":
    case "freehand":
      return { ...element, points: element.points.map(mapPoint) };
    case "text":
      return {
        ...element,
        x:
          element.align === "center"
            ? next.x + safeWidth / 2
            : element.align === "right"
              ? next.x + safeWidth
              : next.x,
        y: next.y,
        fontSize: Math.max(1, element.fontSize * scaleY),
        maxWidth: safeWidth,
      };
  }
}

export function pointInSceneElement(
  element: SceneElement,
  point: Readonly<ScenePoint>,
  tolerance = 0,
): boolean {
  const local = unrotatePoint(point, elementCenter(element), element.rotation);
  switch (element.type) {
    case "rectangle":
      return pointInRectangle(element, local, tolerance);
    case "ellipse":
      return pointInEllipse(element, local, tolerance);
    case "image":
      return pointInBounds(elementBounds(element), local, tolerance);
    case "text":
      return pointInBounds(elementBounds(element), local, tolerance);
    case "line":
      return (
        distanceToSegment(local, element.start, element.end) <=
        Math.max(tolerance, element.style.strokeWidth / 2)
      );
    case "polyline":
      return pointInPolyline(element, local, tolerance);
    case "freehand":
      return pointNearPoints(element, local, tolerance);
  }
}

export function hitTestScene(
  document: Pick<SceneDocument, "elements">,
  point: Readonly<ScenePoint>,
  options: HitTestOptions = {},
): SceneElement | undefined {
  const roles = options.roles ?? ["collision", "both"];
  const tolerance = Math.max(0, options.tolerance ?? 0);
  for (let index = document.elements.length - 1; index >= 0; index -= 1) {
    const element = document.elements[index];
    if (
      element !== undefined &&
      (options.includeInvisible === true || element.visible) &&
      roles.includes(element.role) &&
      pointInSceneElement(element, point, tolerance)
    ) {
      return element;
    }
  }
  return undefined;
}

export function rotatePoint(
  point: Readonly<ScenePoint>,
  center: Readonly<ScenePoint>,
  degrees: number,
): ScenePoint {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const x = point.x - center.x;
  const y = point.y - center.y;
  return {
    x: center.x + x * cosine - y * sine,
    y: center.y + x * sine + y * cosine,
  };
}

function unrotatePoint(
  point: Readonly<ScenePoint>,
  center: Readonly<ScenePoint>,
  degrees: number,
): ScenePoint {
  return rotatePoint(point, center, -degrees);
}

function boundsFromPoints(points: readonly ScenePoint[]): SceneBounds {
  const first = points[0] ?? { x: 0, y: 0 };
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x;
  let maxY = first.y;
  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function pointInBounds(
  bounds: SceneBounds,
  point: Readonly<ScenePoint>,
  tolerance: number,
): boolean {
  return (
    point.x >= bounds.x - tolerance &&
    point.x <= bounds.x + bounds.width + tolerance &&
    point.y >= bounds.y - tolerance &&
    point.y <= bounds.y + bounds.height + tolerance
  );
}

function pointInRectangle(
  rectangle: RectangleElement,
  point: Readonly<ScenePoint>,
  tolerance: number,
): boolean {
  if (!pointInBounds(elementBounds(rectangle), point, tolerance)) return false;
  const radius = Math.min(rectangle.cornerRadius, rectangle.width / 2, rectangle.height / 2);
  if (radius <= 0) return true;

  const innerLeft = rectangle.x + radius;
  const innerRight = rectangle.x + rectangle.width - radius;
  const innerTop = rectangle.y + radius;
  const innerBottom = rectangle.y + rectangle.height - radius;
  if (
    (point.x >= innerLeft - tolerance && point.x <= innerRight + tolerance) ||
    (point.y >= innerTop - tolerance && point.y <= innerBottom + tolerance)
  ) {
    return true;
  }

  const cornerX = point.x < innerLeft ? innerLeft : innerRight;
  const cornerY = point.y < innerTop ? innerTop : innerBottom;
  return Math.hypot(point.x - cornerX, point.y - cornerY) <= radius + tolerance;
}

function pointInEllipse(
  ellipse: EllipseElement,
  point: Readonly<ScenePoint>,
  tolerance: number,
): boolean {
  const rx = ellipse.rx + tolerance;
  const ry = ellipse.ry + tolerance;
  const dx = (point.x - ellipse.cx) / rx;
  const dy = (point.y - ellipse.cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function pointInPolyline(
  polyline: PolylineElement,
  point: Readonly<ScenePoint>,
  tolerance: number,
): boolean {
  if (polyline.closed && pointInPolygon(polyline.points, point)) return true;
  return pointNearSegments(
    polyline.points,
    point,
    Math.max(tolerance, polyline.style.strokeWidth / 2),
    polyline.closed,
  );
}

function pointNearPoints(
  freehand: FreehandElement,
  point: Readonly<ScenePoint>,
  tolerance: number,
): boolean {
  return pointNearSegments(
    sampleSmoothPoints(freehand.points, freehand.smoothing),
    point,
    Math.max(tolerance, freehand.style.strokeWidth / 2),
    false,
  );
}

function pointNearSegments(
  points: readonly ScenePoint[],
  point: Readonly<ScenePoint>,
  tolerance: number,
  closed: boolean,
): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (
      start !== undefined &&
      end !== undefined &&
      distanceToSegment(point, start, end) <= tolerance
    ) {
      return true;
    }
  }
  const first = points[0];
  const last = points.at(-1);
  return (
    closed &&
    first !== undefined &&
    last !== undefined &&
    distanceToSegment(point, last, first) <= tolerance
  );
}

function pointInPolygon(points: readonly ScenePoint[], point: Readonly<ScenePoint>): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const currentPoint = points[index];
    const previousPoint = points[previous];
    if (currentPoint === undefined || previousPoint === undefined) continue;
    const intersects =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegment(
  point: Readonly<ScenePoint>,
  start: Readonly<ScenePoint>,
  end: Readonly<ScenePoint>,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
}
