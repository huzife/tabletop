import { z } from "zod";

import { commandErrorPayloadSchema } from "../errors.js";
import {
  connectionIdSchema,
  gameIdSchema,
  matchIdSchema,
  messageIdSchema,
  requestIdSchema,
  revisionSchema,
  roomIdSchema,
  seatIdSchema,
  utcDateTimeSchema,
} from "../ids.js";
import type { JsonValue } from "../json.js";
import {
  memberConnectionStatusSchema,
  roomSnapshotPayloadSchema,
  seatControllerSchema,
  type RoomSnapshotPayload,
} from "./room-snapshot.js";

const serverEnvelopeFields = {
  protocol: z.literal(1),
  messageId: messageIdSchema,
  serverTime: utcDateTimeSchema,
} as const;

export const connectionReadyMessageSchema = z.strictObject({
  ...serverEnvelopeFields,
  type: z.literal("connection.ready"),
  payload: z.strictObject({
    connectionId: connectionIdSchema,
    heartbeatIntervalMs: z.number().int().positive().safe(),
    pongTimeoutMs: z.number().int().positive().safe(),
  }),
});

export const commandAckMessageSchema = z.strictObject({
  ...serverEnvelopeFields,
  type: z.literal("command.ack"),
  roomId: roomIdSchema.optional(),
  matchId: matchIdSchema.optional(),
  revision: revisionSchema.optional(),
  causedBy: requestIdSchema,
  payload: z.strictObject({
    stateChanged: z.boolean(),
  }),
});

export const commandErrorMessageSchema = z.strictObject({
  ...serverEnvelopeFields,
  type: z.literal("command.error"),
  roomId: roomIdSchema.optional(),
  matchId: matchIdSchema.optional(),
  revision: revisionSchema.optional(),
  causedBy: requestIdSchema,
  payload: commandErrorPayloadSchema,
});

export const roomSnapshotMessageSchema = z.strictObject({
  ...serverEnvelopeFields,
  type: z.literal("room.snapshot"),
  roomId: roomIdSchema,
  matchId: matchIdSchema.optional(),
  revision: revisionSchema,
  causedBy: requestIdSchema.optional(),
  payload: roomSnapshotPayloadSchema,
});

export const roomClosedReasonSchema = z.enum([
  "site_disabled",
  "game_disabled",
  "last_human_left",
  "host_closed",
  "internal_error",
]);

export const roomClosedMessageSchema = z.strictObject({
  ...serverEnvelopeFields,
  type: z.literal("room.closed"),
  roomId: roomIdSchema,
  matchId: matchIdSchema.optional(),
  revision: revisionSchema.optional(),
  payload: z.strictObject({
    reason: roomClosedReasonSchema,
    message: z.string().min(1).max(500),
  }),
});

export const roomConnectionChangedMessageSchema = z.strictObject({
  ...serverEnvelopeFields,
  type: z.literal("room.connection.changed"),
  roomId: roomIdSchema,
  matchId: matchIdSchema.optional(),
  revision: revisionSchema,
  payload: z.strictObject({
    seatId: seatIdSchema,
    connectionStatus: memberConnectionStatusSchema,
    reconnectUntil: utcDateTimeSchema.optional(),
    controller: seatControllerSchema,
  }),
});

export const serviceStatusChangedMessageSchema = z.strictObject({
  ...serverEnvelopeFields,
  type: z.literal("service.status.changed"),
  payload: z.discriminatedUnion("scope", [
    z.strictObject({
      scope: z.literal("site"),
      enabled: z.boolean(),
    }),
    z.strictObject({
      scope: z.literal("game"),
      gameId: gameIdSchema,
      enabled: z.boolean(),
    }),
  ]),
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  connectionReadyMessageSchema,
  commandAckMessageSchema,
  commandErrorMessageSchema,
  roomSnapshotMessageSchema,
  roomClosedMessageSchema,
  roomConnectionChangedMessageSchema,
  serviceStatusChangedMessageSchema,
]);

type BaseRoomSnapshotMessage = z.infer<typeof roomSnapshotMessageSchema>;

export type RoomSnapshotMessage<
  TSettings extends JsonValue = JsonValue,
  TView extends JsonValue = JsonValue,
  TDisplayEvent extends JsonValue = JsonValue,
> = Omit<BaseRoomSnapshotMessage, "payload"> & {
  readonly payload: RoomSnapshotPayload<TSettings, TView, TDisplayEvent>;
};

export type CommandAckMessage = z.infer<typeof commandAckMessageSchema>;
export type CommandErrorMessage = z.infer<typeof commandErrorMessageSchema>;
export type ConnectionReadyMessage = z.infer<typeof connectionReadyMessageSchema>;
export type RoomClosedMessage = z.infer<typeof roomClosedMessageSchema>;
export type RoomConnectionChangedMessage = z.infer<typeof roomConnectionChangedMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ServiceStatusChangedMessage = z.infer<typeof serviceStatusChangedMessageSchema>;
