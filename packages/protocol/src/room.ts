import { z } from "zod";

export const roomStatusSchema = z.enum(["lobby", "playing", "post_match"]);

export type RoomStatus = z.infer<typeof roomStatusSchema>;
