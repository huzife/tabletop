import { z } from "zod";

import {
  connectionIdSchema,
  gameIdSchema,
  joinTicketSchema,
  roomIdSchema,
  utcDateTimeSchema,
} from "../ids.js";
import { jsonValueSchema } from "../json.js";
import { roomStatusSchema } from "../room.js";
import { serverMessageSchema } from "../ws/server-messages.js";
export { roomStatusSchema } from "../room.js";
export type { RoomStatus } from "../room.js";

const queryBooleanSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

export const roomSummarySchema = z.strictObject({
  roomId: roomIdSchema,
  gameId: gameIdSchema,
  name: z.string().min(1).max(30),
  hostName: z.string().min(1).max(64),
  status: roomStatusSchema,
  occupiedSeats: z.number().int().nonnegative(),
  maxPlayers: z.number().int().positive(),
  spectatorCount: z.number().int().nonnegative(),
  maxSpectators: z.number().int().nonnegative(),
  hasPassword: z.boolean(),
  joinable: z.boolean(),
  resumeAvailable: z.boolean(),
});

export const roomListQuerySchema = z.strictObject({
  gameId: gameIdSchema.optional(),
  status: roomStatusSchema.optional(),
  joinable: queryBooleanSchema.optional(),
});

export const roomsResponseSchema = z.strictObject({
  rooms: z.array(roomSummarySchema),
});

export const createRoomRequestSchema = z
  .strictObject({
    botProfileId: z.string().min(1).max(64).optional(),
    gameId: gameIdSchema,
    name: z.string().trim().min(1).max(30),
    password: z.string().min(1).max(128).optional(),
    settings: jsonValueSchema,
    practice: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    if (!value.practice && value.botProfileId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "botProfileId is only valid for practice rooms",
        path: ["botProfileId"],
      });
    }
  });

export const createRoomResponseSchema = z.strictObject({
  roomId: roomIdSchema,
  inviteUrl: z.string().url().max(2_048),
  joinTicket: joinTicketSchema,
  joinTicketExpiresAt: utcDateTimeSchema,
});

export const joinTicketRequestSchema = z.strictObject({
  password: z.string().min(1).max(128).optional(),
});

export const joinTicketResponseSchema = z.strictObject({
  roomId: roomIdSchema,
  joinTicket: joinTicketSchema,
  expiresAt: utcDateTimeSchema,
});

export const roomConnectionOpenRequestSchema = z.strictObject({
  protocol: z.literal(1),
});

const roomConnectionCloseSchema = z.strictObject({
  code: z.number().int().min(1_000).max(4_999),
  reason: z.string().max(120),
});

export const roomConnectionOpenResponseSchema = z.strictObject({
  connectionId: connectionIdSchema,
  messages: z.array(serverMessageSchema).min(1).max(128),
});

export const roomConnectionPollResponseSchema = z.strictObject({
  messages: z.array(serverMessageSchema).max(128),
  close: roomConnectionCloseSchema.optional(),
});

export const roomConnectionCommandResponseSchema = z.strictObject({
  accepted: z.literal(true),
});

export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;
export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>;
export type JoinTicketRequest = z.infer<typeof joinTicketRequestSchema>;
export type JoinTicketResponse = z.infer<typeof joinTicketResponseSchema>;
export type RoomConnectionCommandResponse = z.infer<typeof roomConnectionCommandResponseSchema>;
export type RoomConnectionOpenRequest = z.infer<typeof roomConnectionOpenRequestSchema>;
export type RoomConnectionOpenResponse = z.infer<typeof roomConnectionOpenResponseSchema>;
export type RoomConnectionPollResponse = z.infer<typeof roomConnectionPollResponseSchema>;
export type RoomListQuery = z.infer<typeof roomListQuerySchema>;
export type RoomSummary = z.infer<typeof roomSummarySchema>;
export type RoomsResponse = z.infer<typeof roomsResponseSchema>;
