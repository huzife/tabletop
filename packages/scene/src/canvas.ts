import { calculateSceneViewport, type ViewportSize } from "./coordinates.js";
import { elementBounds, elementCenter } from "./geometry.js";
import type {
  ImageElement,
  SceneDocument,
  SceneElement,
  ScenePoint,
  SceneStyle,
} from "./schema.js";

export interface RenderSceneOptions extends ViewportSize {
  readonly clear?: boolean;
  readonly showVisuals?: boolean;
  readonly showCollisionOverlay?: boolean;
  readonly images?: ReadonlyMap<string, CanvasImageSource>;
}

export function renderSceneToCanvas(
  context: CanvasRenderingContext2D,
  document: SceneDocument,
  options: RenderSceneOptions,
): void {
  const viewport = calculateSceneViewport(document.canvas, options);
  if (options.clear !== false) context.clearRect(0, 0, options.width, options.height);

  context.save();
  context.translate(viewport.offsetX, viewport.offsetY);
  context.scale(viewport.scale, viewport.scale);
  context.beginPath();
  context.rect(0, 0, document.canvas.width, document.canvas.height);
  context.clip();
  context.fillStyle = document.canvas.background;
  context.fillRect(0, 0, document.canvas.width, document.canvas.height);

  if (options.showVisuals !== false) {
    for (const element of document.elements) {
      if (element.visible && element.role !== "collision") {
        drawElement(context, element, options.images);
      }
    }
  }

  if (options.showCollisionOverlay === true) {
    for (const element of document.elements) {
      if (element.visible && element.role !== "visual") drawCollisionOverlay(context, element);
    }
  }
  context.restore();
}

function drawElement(
  context: CanvasRenderingContext2D,
  element: SceneElement,
  images: ReadonlyMap<string, CanvasImageSource> | undefined,
): void {
  context.save();
  rotateContext(context, element);
  context.globalAlpha = element.opacity;
  applyStyle(context, element.style);

  switch (element.type) {
    case "rectangle":
      roundedRectanglePath(
        context,
        element.x,
        element.y,
        element.width,
        element.height,
        element.cornerRadius,
      );
      fillAndStroke(context, element.style);
      break;
    case "ellipse":
      context.beginPath();
      context.ellipse(element.cx, element.cy, element.rx, element.ry, 0, 0, Math.PI * 2);
      fillAndStroke(context, element.style);
      break;
    case "line":
      context.beginPath();
      context.moveTo(element.start.x, element.start.y);
      context.lineTo(element.end.x, element.end.y);
      context.stroke();
      if (element.arrowStart) drawArrow(context, element.end, element.start, element.style);
      if (element.arrowEnd) drawArrow(context, element.start, element.end, element.style);
      break;
    case "polyline":
      tracePoints(context, element.points, element.closed);
      fillAndStroke(context, element.style, element.closed);
      break;
    case "freehand":
      traceSmoothPoints(context, element.points, element.smoothing);
      context.stroke();
      break;
    case "text":
      drawText(context, element);
      break;
    case "image": {
      const image = images?.get(element.source);
      if (image !== undefined) drawImage(context, element, image);
      else drawImagePlaceholder(context, element);
      if (element.style.strokeWidth > 0) {
        context.strokeRect(element.x, element.y, element.width, element.height);
      }
      break;
    }
  }
  context.restore();
}

function drawCollisionOverlay(context: CanvasRenderingContext2D, element: SceneElement): void {
  context.save();
  rotateContext(context, element);
  context.globalAlpha = 0.9;
  context.fillStyle = "rgb(239 68 68 / 18%)";
  context.strokeStyle = "#ef4444";
  context.lineWidth = Math.max(1, element.style.strokeWidth);
  context.setLineDash([8, 5]);

  switch (element.type) {
    case "rectangle":
      roundedRectanglePath(
        context,
        element.x,
        element.y,
        element.width,
        element.height,
        element.cornerRadius,
      );
      context.fill();
      context.stroke();
      break;
    case "ellipse":
      context.beginPath();
      context.ellipse(element.cx, element.cy, element.rx, element.ry, 0, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      break;
    case "line":
      context.beginPath();
      context.moveTo(element.start.x, element.start.y);
      context.lineTo(element.end.x, element.end.y);
      context.stroke();
      break;
    case "polyline":
      tracePoints(context, element.points, element.closed);
      if (element.closed) context.fill();
      context.stroke();
      break;
    case "freehand":
      traceSmoothPoints(context, element.points, element.smoothing);
      context.stroke();
      break;
    case "text":
    case "image": {
      const bounds = elementBounds(element);
      context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
      context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
      break;
    }
  }
  context.restore();
}

function rotateContext(context: CanvasRenderingContext2D, element: SceneElement): void {
  if (element.rotation === 0) return;
  const center = elementCenter(element);
  context.translate(center.x, center.y);
  context.rotate((element.rotation * Math.PI) / 180);
  context.translate(-center.x, -center.y);
}

function applyStyle(context: CanvasRenderingContext2D, style: SceneStyle): void {
  context.fillStyle = colorWithOpacity(style.fill, style.fillOpacity);
  context.strokeStyle = colorWithOpacity(style.stroke, style.strokeOpacity);
  context.lineWidth = style.strokeWidth;
  context.lineCap = style.lineCap;
  context.lineJoin = style.lineJoin;
  context.setLineDash(style.dash);
}

function fillAndStroke(context: CanvasRenderingContext2D, style: SceneStyle, fill = true): void {
  if (fill && style.fill !== "none" && style.fillOpacity > 0) context.fill();
  if (style.stroke !== "none" && style.strokeOpacity > 0 && style.strokeWidth > 0) context.stroke();
}

function roundedRectanglePath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.roundRect(x, y, width, height, safeRadius);
}

function tracePoints(
  context: CanvasRenderingContext2D,
  points: readonly ScenePoint[],
  closed: boolean,
): void {
  const first = points[0];
  if (first === undefined) return;
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  if (closed) context.closePath();
}

function traceSmoothPoints(
  context: CanvasRenderingContext2D,
  points: readonly ScenePoint[],
  smoothing: number,
): void {
  const first = points[0];
  if (first === undefined) return;
  context.beginPath();
  context.moveTo(first.x, first.y);
  if (smoothing <= 0) {
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    return;
  }
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    if (point === undefined || next === undefined) continue;
    const midpointX = point.x + ((next.x - point.x) * smoothing) / 2;
    const midpointY = point.y + ((next.y - point.y) * smoothing) / 2;
    context.quadraticCurveTo(point.x, point.y, midpointX, midpointY);
  }
  const last = points.at(-1);
  if (last !== undefined) {
    context.quadraticCurveTo(last.x, last.y, last.x, last.y);
  }
}

function drawArrow(
  context: CanvasRenderingContext2D,
  from: Readonly<ScenePoint>,
  to: Readonly<ScenePoint>,
  style: SceneStyle,
): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = Math.max(8, style.strokeWidth * 3);
  context.save();
  context.fillStyle = colorWithOpacity(style.stroke, style.strokeOpacity);
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(to.x, to.y);
  context.lineTo(
    to.x - Math.cos(angle - Math.PI / 6) * size,
    to.y - Math.sin(angle - Math.PI / 6) * size,
  );
  context.lineTo(
    to.x - Math.cos(angle + Math.PI / 6) * size,
    to.y - Math.sin(angle + Math.PI / 6) * size,
  );
  context.closePath();
  context.fill();
  context.restore();
}

function drawText(
  context: CanvasRenderingContext2D,
  element: Extract<SceneElement, { type: "text" }>,
): void {
  const weight = element.fontWeight === "semibold" ? 600 : element.fontWeight;
  context.font = `${weight} ${element.fontSize}px ${element.fontFamily}`;
  context.textAlign = element.align;
  context.textBaseline = "top";
  const lines = element.text.split("\n");
  lines.forEach((line, index) => {
    context.fillText(
      line,
      element.x,
      element.y + index * element.fontSize * element.lineHeight,
      element.maxWidth,
    );
  });
}

function drawImage(
  context: CanvasRenderingContext2D,
  element: ImageElement,
  image: CanvasImageSource,
): void {
  if (element.fit === "fill") {
    context.drawImage(image, element.x, element.y, element.width, element.height);
    return;
  }
  const { width: sourceWidth, height: sourceHeight } = canvasImageSourceSize(image);
  const sourceRatio = sourceWidth / Math.max(1, sourceHeight);
  const targetRatio = element.width / element.height;

  if (element.fit === "contain") {
    const width = sourceRatio > targetRatio ? element.width : element.height * sourceRatio;
    const height = sourceRatio > targetRatio ? element.width / sourceRatio : element.height;
    context.drawImage(
      image,
      element.x + (element.width - width) / 2,
      element.y + (element.height - height) / 2,
      width,
      height,
    );
    return;
  }

  const cropWidth = sourceRatio > targetRatio ? sourceHeight * targetRatio : sourceWidth;
  const cropHeight = sourceRatio > targetRatio ? sourceHeight : sourceWidth / targetRatio;
  context.drawImage(
    image,
    (sourceWidth - cropWidth) / 2,
    (sourceHeight - cropHeight) / 2,
    cropWidth,
    cropHeight,
    element.x,
    element.y,
    element.width,
    element.height,
  );
}

function canvasImageSourceSize(image: CanvasImageSource): {
  readonly width: number;
  readonly height: number;
} {
  const dimensions = image as {
    readonly width?: number;
    readonly height?: number;
    readonly naturalWidth?: number;
    readonly naturalHeight?: number;
    readonly videoWidth?: number;
    readonly videoHeight?: number;
    readonly displayWidth?: number;
    readonly displayHeight?: number;
  };
  return {
    width: Math.max(
      1,
      dimensions.naturalWidth ??
        dimensions.videoWidth ??
        dimensions.displayWidth ??
        dimensions.width ??
        1,
    ),
    height: Math.max(
      1,
      dimensions.naturalHeight ??
        dimensions.videoHeight ??
        dimensions.displayHeight ??
        dimensions.height ??
        1,
    ),
  };
}

function drawImagePlaceholder(context: CanvasRenderingContext2D, element: ImageElement): void {
  context.save();
  context.fillStyle = "#e2e8f0";
  context.fillRect(element.x, element.y, element.width, element.height);
  context.strokeStyle = "#94a3b8";
  context.lineWidth = 1;
  context.setLineDash([5, 4]);
  context.strokeRect(element.x, element.y, element.width, element.height);
  context.beginPath();
  context.moveTo(element.x, element.y);
  context.lineTo(element.x + element.width, element.y + element.height);
  context.moveTo(element.x + element.width, element.y);
  context.lineTo(element.x, element.y + element.height);
  context.stroke();
  context.restore();
}

function colorWithOpacity(color: string, opacity: number): string {
  if (opacity >= 1 || color === "none") return color;
  if (/^#[\da-f]{6}$/i.test(color)) {
    const alpha = Math.round(opacity * 255)
      .toString(16)
      .padStart(2, "0");
    return `${color}${alpha}`;
  }
  return color;
}
