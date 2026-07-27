import { z } from "zod";

export const SCENE_FORMAT = "tabletop.scene" as const;
export const SCENE_FORMAT_VERSION = 1 as const;

const finiteNumber = z.number().finite();
const nonNegativeNumber = finiteNumber.nonnegative();
const positiveNumber = finiteNumber.positive();
const color = z.string().min(1).max(128);

export const scenePointSchema = z
  .object({
    x: finiteNumber,
    y: finiteNumber,
  })
  .strict();

export const sceneStyleSchema = z
  .object({
    fill: color,
    fillOpacity: finiteNumber.min(0).max(1),
    stroke: color,
    strokeOpacity: finiteNumber.min(0).max(1),
    strokeWidth: nonNegativeNumber,
    dash: z.array(nonNegativeNumber).max(16),
    lineCap: z.enum(["butt", "round", "square"]),
    lineJoin: z.enum(["bevel", "miter", "round"]),
  })
  .strict();

export const sceneMetadataSchema = z
  .object({
    label: z.string().max(256),
    notes: z.string().max(4096),
    tags: z.array(z.string().min(1).max(64)).max(32),
  })
  .strict();

const baseElementFields = {
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  role: z.enum(["visual", "collision", "both"]),
  visible: z.boolean(),
  locked: z.boolean(),
  opacity: finiteNumber.min(0).max(1),
  rotation: finiteNumber,
  style: sceneStyleSchema,
  metadata: sceneMetadataSchema,
};

export const rectangleElementSchema = z
  .object({
    ...baseElementFields,
    type: z.literal("rectangle"),
    x: finiteNumber,
    y: finiteNumber,
    width: positiveNumber,
    height: positiveNumber,
    cornerRadius: nonNegativeNumber,
  })
  .strict();

export const ellipseElementSchema = z
  .object({
    ...baseElementFields,
    type: z.literal("ellipse"),
    cx: finiteNumber,
    cy: finiteNumber,
    rx: positiveNumber,
    ry: positiveNumber,
  })
  .strict();

export const lineElementSchema = z
  .object({
    ...baseElementFields,
    type: z.literal("line"),
    start: scenePointSchema,
    end: scenePointSchema,
    arrowStart: z.boolean(),
    arrowEnd: z.boolean(),
  })
  .strict();

export const polylineElementSchema = z
  .object({
    ...baseElementFields,
    type: z.literal("polyline"),
    points: z.array(scenePointSchema).min(2).max(4096),
    closed: z.boolean(),
  })
  .strict();

export const freehandElementSchema = z
  .object({
    ...baseElementFields,
    type: z.literal("freehand"),
    points: z.array(scenePointSchema).min(2).max(8192),
    smoothing: finiteNumber.min(0).max(1),
  })
  .strict();

export const textElementSchema = z
  .object({
    ...baseElementFields,
    type: z.literal("text"),
    x: finiteNumber,
    y: finiteNumber,
    text: z.string().max(8192),
    fontFamily: z.string().min(1).max(256),
    fontSize: positiveNumber,
    fontWeight: z.enum(["normal", "medium", "semibold", "bold"]),
    lineHeight: positiveNumber,
    align: z.enum(["left", "center", "right"]),
    maxWidth: positiveNumber,
  })
  .strict();

export const imageElementSchema = z
  .object({
    ...baseElementFields,
    type: z.literal("image"),
    x: finiteNumber,
    y: finiteNumber,
    width: positiveNumber,
    height: positiveNumber,
    source: z.string().min(1).max(8_000_000),
    alt: z.string().max(1024),
    fit: z.enum(["contain", "cover", "fill"]),
  })
  .strict();

export const sceneElementSchema = z.discriminatedUnion("type", [
  rectangleElementSchema,
  ellipseElementSchema,
  lineElementSchema,
  polylineElementSchema,
  freehandElementSchema,
  textElementSchema,
  imageElementSchema,
]);

export const sceneDocumentSchema = z
  .object({
    format: z.literal(SCENE_FORMAT),
    formatVersion: z.literal(SCENE_FORMAT_VERSION),
    name: z.string().min(1).max(256),
    canvas: z
      .object({
        width: positiveNumber,
        height: positiveNumber,
        background: color,
        gridSize: positiveNumber,
        coordinateSystem: z
          .object({
            origin: z.literal("top-left"),
            xAxis: z.literal("right"),
            yAxis: z.literal("down"),
            unit: z.literal("scene-unit"),
          })
          .strict(),
        scaleMode: z.literal("contain"),
      })
      .strict(),
    elements: z.array(sceneElementSchema).max(10_000),
  })
  .strict()
  .superRefine((document, context) => {
    const ids = new Set<string>();
    document.elements.forEach((element, index) => {
      if (ids.has(element.id)) {
        context.addIssue({
          code: "custom",
          message: `元素 id “${element.id}” 重复`,
          path: ["elements", index, "id"],
        });
      }
      ids.add(element.id);
    });
  });

export type ScenePoint = z.infer<typeof scenePointSchema>;
export type SceneStyle = z.infer<typeof sceneStyleSchema>;
export type SceneMetadata = z.infer<typeof sceneMetadataSchema>;
export type RectangleElement = z.infer<typeof rectangleElementSchema>;
export type EllipseElement = z.infer<typeof ellipseElementSchema>;
export type LineElement = z.infer<typeof lineElementSchema>;
export type PolylineElement = z.infer<typeof polylineElementSchema>;
export type FreehandElement = z.infer<typeof freehandElementSchema>;
export type TextElement = z.infer<typeof textElementSchema>;
export type ImageElement = z.infer<typeof imageElementSchema>;
export type SceneElement = z.infer<typeof sceneElementSchema>;
export type SceneElementRole = SceneElement["role"];
export type SceneDocument = z.infer<typeof sceneDocumentSchema>;
export type SceneCanvas = SceneDocument["canvas"];

export function parseSceneDocument(input: unknown): SceneDocument {
  return sceneDocumentSchema.parse(input);
}

export function safeParseSceneDocument(
  input: unknown,
): ReturnType<typeof sceneDocumentSchema.safeParse> {
  return sceneDocumentSchema.safeParse(input);
}

export function parseSceneJson(json: string): SceneDocument {
  let input: unknown;
  try {
    input = JSON.parse(json) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "未知 JSON 错误";
    throw new Error(`场景描述文件不是有效的 JSON：${detail}`);
  }

  const result = sceneDocumentSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`场景描述文件不符合 tabletop.scene/v1：${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function serializeSceneDocument(document: SceneDocument): string {
  return `${JSON.stringify(sceneDocumentSchema.parse(document), null, 2)}\n`;
}
