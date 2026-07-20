import { z } from "zod";

export const templateActionSchema = z.strictObject({ type: z.literal("template.score") });
export type TemplateAction = z.infer<typeof templateActionSchema>;
