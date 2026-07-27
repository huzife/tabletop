import type { ScenePoint } from "./schema.js";

export function pointsToSmoothSvgPath(points: readonly ScenePoint[], smoothing: number): string {
  const first = points[0];
  if (first === undefined) return "";
  if (points.length === 1 || smoothing <= 0) {
    return `M ${number(first.x)} ${number(first.y)}${points
      .slice(1)
      .map((point) => ` L ${number(point.x)} ${number(point.y)}`)
      .join("")}`;
  }

  let path = `M ${number(first.x)} ${number(first.y)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    if (point === undefined || next === undefined) continue;
    const midpoint = {
      x: point.x + (next.x - point.x) * 0.5 * smoothing,
      y: point.y + (next.y - point.y) * 0.5 * smoothing,
    };
    path += ` Q ${number(point.x)} ${number(point.y)} ${number(midpoint.x)} ${number(midpoint.y)}`;
  }
  const last = points.at(-1);
  if (last !== undefined) {
    path += ` Q ${number(last.x)} ${number(last.y)} ${number(last.x)} ${number(last.y)}`;
  }
  return path;
}

export function sampleSmoothPoints(
  points: readonly ScenePoint[],
  smoothing: number,
  samplesPerCurve = 8,
): ScenePoint[] {
  const first = points[0];
  if (first === undefined) return [];
  if (points.length === 1 || smoothing <= 0) return [...points];

  const output: ScenePoint[] = [first];
  let start = first;
  const samples = Math.max(2, Math.floor(samplesPerCurve));
  for (let index = 1; index < points.length - 1; index += 1) {
    const control = points[index];
    const next = points[index + 1];
    if (control === undefined || next === undefined) continue;
    const end = {
      x: control.x + (next.x - control.x) * 0.5 * smoothing,
      y: control.y + (next.y - control.y) * 0.5 * smoothing,
    };
    appendQuadraticSamples(output, start, control, end, samples);
    start = end;
  }

  const last = points.at(-1);
  if (last !== undefined) {
    appendQuadraticSamples(output, start, last, last, samples);
  }
  return output;
}

function appendQuadraticSamples(
  output: ScenePoint[],
  start: ScenePoint,
  control: ScenePoint,
  end: ScenePoint,
  samples: number,
): void {
  for (let index = 1; index <= samples; index += 1) {
    const time = index / samples;
    const inverse = 1 - time;
    output.push({
      x: inverse * inverse * start.x + 2 * inverse * time * control.x + time * time * end.x,
      y: inverse * inverse * start.y + 2 * inverse * time * control.y + time * time * end.y,
    });
  }
}

function number(value: number): string {
  return Number(value.toFixed(3)).toString();
}
