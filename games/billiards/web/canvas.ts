import type { BilliardsMode } from "../shared/settings.js";
import type { BilliardsBall } from "../shared/view.js";
import type { BilliardsTableSpec, TablePocketSpec } from "../shared/table.js";

export type CanvasBall = BilliardsBall & { readonly z?: number };

type CanvasTableSpec = Pick<
  BilliardsTableSpec,
  | "ballDiameter"
  | "baulkLineX"
  | "circularCushions"
  | "cushionWidth"
  | "dRadius"
  | "height"
  | "linearCushions"
  | "outerHeight"
  | "outerWidth"
  | "pockets"
  | "spots"
  | "width"
>;

export interface TableGeometry {
  readonly height: number;
  readonly left: number;
  readonly outerHeight: number;
  readonly outerWidth: number;
  readonly playHeight: number;
  readonly playLeft: number;
  readonly playTop: number;
  readonly playWidth: number;
  readonly rail: number;
  readonly railX: number;
  readonly railY: number;
  readonly scale: number;
  readonly top: number;
  readonly width: number;
}

export interface TablePoint {
  readonly x: number;
  readonly y: number;
}

export interface PocketCircle {
  readonly radius: number;
  readonly x: number;
  readonly y: number;
}

export function tableGeometry(
  canvasWidth: number,
  canvasHeight: number,
  table: Pick<BilliardsTableSpec, "height" | "outerHeight" | "outerWidth" | "width">,
): TableGeometry {
  const safeWidth = Math.max(1, canvasWidth);
  const safeHeight = Math.max(1, canvasHeight);
  const outerWidthMetres = Math.max(table.width, table.outerWidth);
  const outerHeightMetres = Math.max(table.height, table.outerHeight);
  const scale = Math.min(
    Math.max(1, safeWidth - 12) / outerWidthMetres,
    Math.max(1, safeHeight - 12) / outerHeightMetres,
  );
  const playWidth = table.width * scale;
  const playHeight = table.height * scale;
  const outerWidth = outerWidthMetres * scale;
  const outerHeight = outerHeightMetres * scale;
  const railX = ((outerWidthMetres - table.width) * scale) / 2;
  const railY = ((outerHeightMetres - table.height) * scale) / 2;
  const left = (safeWidth - outerWidth) / 2;
  const top = (safeHeight - outerHeight) / 2;
  return {
    height: safeHeight,
    left,
    outerHeight,
    outerWidth,
    playHeight,
    playLeft: left + railX,
    playTop: top + railY,
    playWidth,
    rail: Math.min(railX, railY),
    railX,
    railY,
    scale,
    top,
    width: safeWidth,
  };
}

export function tablePointFromClient(
  clientX: number,
  clientY: number,
  bounds: {
    readonly height: number;
    readonly left: number;
    readonly top: number;
    readonly width: number;
  },
  geometry: TableGeometry,
): TablePoint {
  const localX = ((clientX - bounds.left) / Math.max(1, bounds.width)) * geometry.width;
  const localY = ((clientY - bounds.top) / Math.max(1, bounds.height)) * geometry.height;
  return {
    x: (localX - geometry.playLeft) / geometry.scale,
    y: (geometry.playTop + geometry.playHeight - localY) / geometry.scale,
  };
}

export function pocketCircle(
  geometry: Pick<TableGeometry, "playHeight" | "playLeft" | "playTop" | "scale">,
  pocket: TablePocketSpec,
): PocketCircle {
  // This is the authoritative ball-centre point-of-no-return circle, so it
  // must not be shifted or enlarged for presentation.
  return {
    radius: pocket.captureRadius * geometry.scale,
    x: geometry.playLeft + pocket.captureX * geometry.scale,
    y: tableY(geometry, pocket.captureY),
  };
}

export function pocketMouthCircle(
  geometry: Pick<TableGeometry, "playHeight" | "playLeft" | "playTop" | "scale">,
  pocket: TablePocketSpec,
): PocketCircle {
  return {
    radius: (pocket.mouthWidth * geometry.scale) / 2,
    x: geometry.playLeft + pocket.x * geometry.scale,
    y: tableY(geometry, pocket.y),
  };
}

export function drawBilliardsTable(
  context: CanvasRenderingContext2D,
  geometry: TableGeometry,
  table: CanvasTableSpec,
  mode: BilliardsMode,
  balls: readonly CanvasBall[],
  angle: number,
  elevation: number,
  tip: { readonly x: number; readonly y: number },
  options: {
    readonly aimEnabled: boolean;
    readonly drawTableBackground?: (
      context: CanvasRenderingContext2D,
      geometry: TableGeometry,
    ) => boolean;
    readonly placementPoint?: TablePoint;
    readonly placementValid?: boolean;
    readonly requiredTableBackground?: boolean;
    readonly tableBackgroundMessage?: string;
  },
): void {
  const { playLeft, scale } = geometry;
  context.clearRect(0, 0, geometry.width, geometry.height);
  context.fillStyle = "#e9eeeb";
  context.fillRect(0, 0, geometry.width, geometry.height);

  const sceneBackgroundDrawn = options.drawTableBackground?.(context, geometry) === true;
  if (!sceneBackgroundDrawn && options.requiredTableBackground === true) {
    drawTableBackgroundMessage(
      context,
      geometry,
      options.tableBackgroundMessage ?? "球桌场景加载中…",
    );
    return;
  }

  const radius = (table.ballDiameter * scale) / 2;
  if (!sceneBackgroundDrawn) {
    drawOuterTable(context, geometry, mode);
    for (const pocket of table.pockets) {
      const circle = pocketMouthCircle(geometry, pocket);
      drawPocket(context, circle.x, circle.y, circle.radius);
    }
    drawCushionGeometry(context, geometry, table, mode);
  }
  drawMarkings(context, geometry, table, mode);

  if (options.placementPoint !== undefined) {
    const point = options.placementPoint;
    const px = playLeft + point.x * scale;
    const py = tableY(geometry, point.y);
    context.save();
    context.globalAlpha = 0.82;
    context.setLineDash([5, 4]);
    context.lineWidth = 2;
    context.strokeStyle = options.placementValid === false ? "#d54b42" : "#4bc995";
    context.beginPath();
    context.arc(px, py, radius * 1.1, 0, Math.PI * 2);
    context.stroke();
    context.setLineDash([]);
    context.restore();
  }

  for (const ball of balls) {
    if (ball.pocketed) continue;
    drawBall(context, ball, geometry, radius);
  }

  const cueBall = balls.find((ball) => ball.kind === "cue" && !ball.pocketed);
  if (cueBall !== undefined && options.aimEnabled) {
    drawAim(context, cueBall, balls, geometry, angle, elevation, tip, mode, table.ballDiameter);
  }
}

function drawTableBackgroundMessage(
  context: CanvasRenderingContext2D,
  geometry: TableGeometry,
  message: string,
): void {
  context.save();
  context.fillStyle = "#58635d";
  context.font = "600 14px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(message, geometry.width / 2, geometry.height / 2);
  context.restore();
}

function drawOuterTable(
  context: CanvasRenderingContext2D,
  geometry: TableGeometry,
  mode: BilliardsMode,
): void {
  const { outerHeight, outerWidth } = geometry;
  const wood = context.createLinearGradient(
    geometry.left,
    geometry.top,
    geometry.left + outerWidth,
    geometry.top + outerHeight,
  );
  wood.addColorStop(0, "#b66c3c");
  wood.addColorStop(0.45, "#7d3f24");
  wood.addColorStop(1, "#4c241b");
  context.save();
  context.shadowColor = "rgb(26 31 27 / 28%)";
  context.shadowBlur = 14;
  context.shadowOffsetY = 5;
  context.fillStyle = wood;
  fillRoundedRect(
    context,
    geometry.left,
    geometry.top,
    outerWidth,
    outerHeight,
    geometry.rail * 0.7,
  );
  context.restore();

  const cushion = context.createLinearGradient(
    geometry.playLeft,
    geometry.playTop,
    geometry.playLeft,
    geometry.playTop + geometry.playHeight,
  );
  cushion.addColorStop(0, mode === "snooker" ? "#204d3d" : "#13466c");
  cushion.addColorStop(0.48, mode === "snooker" ? "#133c30" : "#103756");
  cushion.addColorStop(1, mode === "snooker" ? "#0d2d24" : "#0a2b42");
  context.fillStyle = cushion;
  fillRoundedRect(
    context,
    geometry.playLeft - geometry.rail * 0.32,
    geometry.playTop - geometry.rail * 0.32,
    geometry.playWidth + geometry.rail * 0.64,
    geometry.playHeight + geometry.rail * 0.64,
    geometry.rail * 0.28,
  );

  const cloth = context.createLinearGradient(
    geometry.playLeft,
    geometry.playTop,
    geometry.playLeft + geometry.playWidth,
    geometry.playTop + geometry.playHeight,
  );
  if (mode === "snooker") {
    cloth.addColorStop(0, "#18705c");
    cloth.addColorStop(0.52, "#0f5a4a");
    cloth.addColorStop(1, "#0a443a");
  } else {
    cloth.addColorStop(0, "#0d6c92");
    cloth.addColorStop(0.5, "#075c7d");
    cloth.addColorStop(1, "#064762");
  }
  context.fillStyle = cloth;
  context.fillRect(geometry.playLeft, geometry.playTop, geometry.playWidth, geometry.playHeight);

  context.save();
  context.strokeStyle = "rgb(222 246 232 / 32%)";
  context.lineWidth = Math.max(1, geometry.scale * 0.008);
  context.strokeRect(geometry.playLeft, geometry.playTop, geometry.playWidth, geometry.playHeight);
  context.restore();

  drawRailDiamonds(context, geometry, mode);
}

function drawCushionGeometry(
  context: CanvasRenderingContext2D,
  geometry: TableGeometry,
  table: Pick<CanvasTableSpec, "circularCushions" | "linearCushions">,
  mode: BilliardsMode,
): void {
  context.save();
  context.beginPath();
  context.rect(geometry.playLeft, geometry.playTop, geometry.playWidth, geometry.playHeight);
  context.clip();
  context.strokeStyle = mode === "snooker" ? "rgb(226 239 214 / 62%)" : "rgb(214 239 248 / 62%)";
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = Math.max(1, geometry.scale * 0.006);
  context.beginPath();
  for (const cushion of table.linearCushions) {
    context.moveTo(geometry.playLeft + cushion.x1 * geometry.scale, tableY(geometry, cushion.y1));
    context.lineTo(geometry.playLeft + cushion.x2 * geometry.scale, tableY(geometry, cushion.y2));
  }
  for (const cushion of table.circularCushions) {
    context.moveTo(
      geometry.playLeft + (cushion.x + cushion.radius) * geometry.scale,
      tableY(geometry, cushion.y),
    );
    context.arc(
      geometry.playLeft + cushion.x * geometry.scale,
      tableY(geometry, cushion.y),
      cushion.radius * geometry.scale,
      0,
      Math.PI * 2,
    );
  }
  context.stroke();
  context.restore();
}

function drawRailDiamonds(
  context: CanvasRenderingContext2D,
  geometry: TableGeometry,
  mode: BilliardsMode,
): void {
  const count = 7;
  const color = mode === "snooker" ? "#d9bd70" : "#f0cf7a";
  context.save();
  context.fillStyle = color;
  for (let index = 1; index < count; index += 1) {
    const x = geometry.playLeft + (geometry.playWidth * index) / count;
    drawDiamond(context, x, geometry.playTop - geometry.rail * 0.58, geometry.rail * 0.12);
    drawDiamond(
      context,
      x,
      geometry.playTop + geometry.playHeight + geometry.rail * 0.58,
      geometry.rail * 0.12,
    );
  }
  for (let index = 1; index < 4; index += 1) {
    const y = geometry.playTop + (geometry.playHeight * index) / 4;
    drawDiamond(context, geometry.playLeft - geometry.rail * 0.58, y, geometry.rail * 0.12);
    drawDiamond(
      context,
      geometry.playLeft + geometry.playWidth + geometry.rail * 0.58,
      y,
      geometry.rail * 0.12,
    );
  }
  context.restore();
}

function drawMarkings(
  context: CanvasRenderingContext2D,
  geometry: TableGeometry,
  table: CanvasTableSpec,
  mode: BilliardsMode,
): void {
  const { playHeight, playLeft, playTop, playWidth, scale } = geometry;
  const markColor = "rgb(235 249 239 / 58%)";
  context.save();
  context.strokeStyle = markColor;
  context.fillStyle = markColor;
  context.lineWidth = Math.max(1, scale * 0.006);
  if (table.baulkLineX !== null) {
    const lineX = playLeft + table.baulkLineX * scale;
    context.beginPath();
    context.moveTo(lineX, playTop);
    context.lineTo(lineX, playTop + playHeight);
    context.stroke();
    if (mode === "snooker" && table.dRadius !== null) {
      context.beginPath();
      context.arc(
        lineX,
        playTop + playHeight / 2,
        table.dRadius * scale,
        Math.PI / 2,
        Math.PI * 1.5,
      );
      context.stroke();
    }
  }
  for (const spot of table.spots) {
    context.beginPath();
    context.arc(
      playLeft + spot.x * scale,
      playTop + playHeight - spot.y * scale,
      Math.max(1.5, scale * 0.012),
      0,
      Math.PI * 2,
    );
    context.fill();
  }
  context.restore();
}

function drawPocket(context: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  const gradient = context.createRadialGradient(
    x - radius * 0.28,
    y - radius * 0.28,
    radius * 0.1,
    x,
    y,
    radius,
  );
  gradient.addColorStop(0, "#28302d");
  gradient.addColorStop(0.68, "#101614");
  gradient.addColorStop(1, "#040807");
  context.save();
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "rgb(241 221 152 / 42%)";
  context.lineWidth = Math.max(1, radius * 0.09);
  context.stroke();
  context.restore();
}

function drawBall(
  context: CanvasRenderingContext2D,
  ball: CanvasBall,
  geometry: TableGeometry,
  radius: number,
): void {
  const { playLeft, scale } = geometry;
  const z = typeof ball.z === "number" && Number.isFinite(ball.z) ? Math.max(0, ball.z) : 0;
  const x = playLeft + ball.x * scale;
  const surfaceY = tableY(geometry, ball.y);
  const y = surfaceY - Math.min(0.25, z) * scale;
  const shadowY = surfaceY + radius * 0.72;
  context.save();
  context.fillStyle = "rgb(14 18 17 / 34%)";
  context.beginPath();
  context.ellipse(x + radius * 0.18, shadowY, radius * 0.86, radius * 0.28, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();

  const color = ballBaseColor(ball);
  const gradient = context.createRadialGradient(
    x - radius * 0.35,
    y - radius * 0.4,
    radius * 0.08,
    x,
    y,
    radius * 1.14,
  );
  gradient.addColorStop(0, lighten(color, 0.54));
  gradient.addColorStop(0.5, color);
  gradient.addColorStop(1, darken(color, 0.34));
  context.save();
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "rgb(5 15 13 / 42%)";
  context.lineWidth = Math.max(0.65, radius * 0.055);
  context.stroke();

  if (ball.kind === "stripe") {
    context.save();
    context.beginPath();
    context.arc(x, y, radius * 0.98, 0, Math.PI * 2);
    context.clip();
    context.translate(x, y);
    context.rotate(ball.rotation);
    context.fillStyle = "#f8f6ee";
    context.fillRect(-radius * 1.2, -radius * 0.25, radius * 2.4, radius * 0.5);
    context.restore();
  }

  const number = ball.number;
  if (
    number !== null &&
    (ball.kind === "solid" || ball.kind === "stripe" || ball.kind === "eight")
  ) {
    context.fillStyle = "#fcfbf2";
    context.beginPath();
    context.arc(x, y, radius * 0.34, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#17211e";
    context.font = `700 ${Math.max(7, radius * 0.65)}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(number), x, y + radius * 0.02);
  }

  const rotation = Number.isFinite(ball.rotation) ? ball.rotation : 0;
  context.fillStyle = "rgb(255 255 255 / 62%)";
  context.beginPath();
  context.arc(
    x - Math.cos(rotation) * radius * 0.48,
    y - Math.sin(rotation) * radius * 0.48,
    Math.max(1, radius * 0.075),
    0,
    Math.PI * 2,
  );
  context.fill();
  context.restore();
}

function drawAim(
  context: CanvasRenderingContext2D,
  cueBall: CanvasBall,
  balls: readonly CanvasBall[],
  geometry: TableGeometry,
  angle: number,
  elevation: number,
  tip: { readonly x: number; readonly y: number },
  mode: BilliardsMode,
  ballDiameter: number,
): void {
  const radius = (ballDiameter * geometry.scale) / 2;
  const x = geometry.playLeft + cueBall.x * geometry.scale;
  const y = tableY(geometry, cueBall.y);
  const directionX = Math.cos(angle);
  const directionY = Math.sin(angle);
  const boundaryDistance = distanceToTableBoundary(
    cueBall.x,
    cueBall.y,
    directionX,
    directionY,
    geometry,
  );
  const target = nearestTarget(cueBall, balls, directionX, directionY, radius / geometry.scale);
  const endpoint =
    target === null ? boundaryDistance : Math.min(boundaryDistance, target.contactDistance);
  context.save();
  context.strokeStyle = mode === "snooker" ? "rgb(242 221 153 / 74%)" : "rgb(222 246 232 / 76%)";
  context.lineWidth = Math.max(1, geometry.scale * 0.006);
  context.setLineDash([7, 6]);
  context.beginPath();
  context.moveTo(x + directionX * radius, y - directionY * radius);
  context.lineTo(
    geometry.playLeft + (cueBall.x + directionX * endpoint) * geometry.scale,
    tableY(geometry, cueBall.y + directionY * endpoint),
  );
  context.stroke();
  context.setLineDash([]);
  if (target !== null && target.contactDistance < boundaryDistance) {
    context.strokeStyle = "rgb(255 241 182 / 86%)";
    context.lineWidth = Math.max(1, geometry.scale * 0.01);
    context.beginPath();
    context.arc(
      geometry.playLeft + (cueBall.x + directionX * target.contactDistance) * geometry.scale,
      tableY(geometry, cueBall.y + directionY * target.contactDistance),
      radius * 0.74,
      0,
      Math.PI * 2,
    );
    context.stroke();
  }
  context.restore();

  drawCue(context, x, y, radius, angle, elevation, geometry.scale);

  context.save();
  context.fillStyle = "#45b9aa";
  context.strokeStyle = "rgb(255 255 255 / 70%)";
  context.lineWidth = 1;
  context.beginPath();
  context.arc(
    x + tip.x * radius * 0.7,
    y - tip.y * radius * 0.7,
    Math.max(1.5, radius * 0.09),
    0,
    Math.PI * 2,
  );
  context.fill();
  context.stroke();
  context.restore();
}

function drawCue(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  angle: number,
  elevation: number,
  scale: number,
): void {
  const dirX = Math.cos(angle);
  const dirY = -Math.sin(angle);
  const projection = 0.36 + Math.cos((elevation * Math.PI) / 180) * 0.64;
  const tipDistance = radius * 1.22;
  const length = Math.max(radius * 4, scale * 0.72) * projection;
  const startX = x - dirX * tipDistance;
  const startY = y - dirY * tipDistance;
  const endX = startX - dirX * length;
  const endY = startY - dirY * length;
  context.save();
  context.lineCap = "round";
  context.strokeStyle = "rgb(17 21 20 / 27%)";
  context.lineWidth = Math.max(4, scale * 0.033);
  context.beginPath();
  context.moveTo(startX + dirY * 3, startY - dirX * 3);
  context.lineTo(endX + dirY * 3, endY - dirX * 3);
  context.stroke();
  const shaft = context.createLinearGradient(startX, startY, endX, endY);
  shaft.addColorStop(0, "#e7d1a2");
  shaft.addColorStop(0.16, "#e5be78");
  shaft.addColorStop(1, "#773d22");
  context.strokeStyle = shaft;
  context.lineWidth = Math.max(2, scale * 0.019);
  context.beginPath();
  context.moveTo(startX, startY);
  context.lineTo(endX, endY);
  context.stroke();
  context.strokeStyle = "#2f9eb2";
  context.lineWidth = Math.max(2.5, scale * 0.022);
  context.beginPath();
  context.moveTo(startX, startY);
  context.lineTo(
    startX - dirX * Math.min(radius * 0.36, scale * 0.08),
    startY - dirY * Math.min(radius * 0.36, scale * 0.08),
  );
  context.stroke();
  context.restore();
}

function nearestTarget(
  cueBall: CanvasBall,
  balls: readonly CanvasBall[],
  directionX: number,
  directionY: number,
  radius: number,
): { readonly contactDistance: number } | null {
  let nearest: number | null = null;
  const collisionDistance = radius * 2;
  for (const ball of balls) {
    if (ball.id === cueBall.id || ball.pocketed) continue;
    const dx = ball.x - cueBall.x;
    const dy = ball.y - cueBall.y;
    const projected = dx * directionX + dy * directionY;
    if (projected <= 0) continue;
    const perpendicular = dx * directionY - dy * directionX;
    if (Math.abs(perpendicular) > collisionDistance) continue;
    const approach = Math.sqrt(
      Math.max(0, collisionDistance * collisionDistance - perpendicular * perpendicular),
    );
    const contact = projected - approach;
    if (contact > 0 && (nearest === null || contact < nearest)) nearest = contact;
  }
  return nearest === null ? null : { contactDistance: nearest };
}

function distanceToTableBoundary(
  x: number,
  y: number,
  directionX: number,
  directionY: number,
  geometry: TableGeometry,
): number {
  const tableWidth = geometry.playWidth / geometry.scale;
  const tableHeight = geometry.playHeight / geometry.scale;
  const tx =
    directionX > 0
      ? (tableWidth - x) / directionX
      : directionX < 0
        ? -x / directionX
        : Number.POSITIVE_INFINITY;
  const ty =
    directionY > 0
      ? (tableHeight - y) / directionY
      : directionY < 0
        ? -y / directionY
        : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(tx, ty));
}

function tableY(
  geometry: Pick<TableGeometry, "playHeight" | "playTop" | "scale">,
  y: number,
): number {
  return geometry.playTop + geometry.playHeight - y * geometry.scale;
}

function ballBaseColor(ball: CanvasBall): string {
  if (ball.kind === "cue") return "#f5f4e9";
  if (ball.kind === "eight") return "#202321";
  if (ball.kind === "red") return "#b9272f";
  const snooker: Readonly<Record<string, string>> = {
    black: "#202321",
    blue: "#2269ba",
    brown: "#8c4e28",
    green: "#2a9a58",
    pink: "#e184a5",
    yellow: "#e4bd28",
  };
  if (ball.kind in snooker) return snooker[ball.kind] ?? "#f2f1e7";
  const pool: readonly string[] = [
    "#e3bb22",
    "#2d65af",
    "#cf292d",
    "#4a2d88",
    "#dc7a22",
    "#2d8e63",
    "#93284f",
    "#252724",
  ];
  return pool[Math.max(0, (ball.number ?? 1) - 1) % pool.length] ?? "#2d65af";
}

function lighten(hex: string, amount: number): string {
  return mixColor(hex, "#ffffff", amount);
}

function darken(hex: string, amount: number): string {
  return mixColor(hex, "#000000", amount);
}

function mixColor(first: string, second: string, amount: number): string {
  const parse = (value: string): [number, number, number] => {
    const normalized = value.replace("#", "");
    return [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
    ];
  };
  const a = parse(first);
  const b = parse(second);
  const mix = (index: number) =>
    Math.round((a[index] ?? 0) * (1 - amount) + (b[index] ?? 0) * amount);
  return `rgb(${mix(0)} ${mix(1)} ${mix(2)})`;
}

function fillRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
  context.fill();
}

function drawDiamond(context: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  context.beginPath();
  context.moveTo(x, y - size);
  context.lineTo(x + size, y);
  context.lineTo(x, y + size);
  context.lineTo(x - size, y);
  context.closePath();
  context.fill();
}
