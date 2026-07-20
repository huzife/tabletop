import { z } from "zod";

import {
  accountIdSchema,
  gameIdSchema,
  memberIdSchema,
  messageIdSchema,
  roomIdSchema,
  seatIdSchema,
  utcDateTimeSchema,
} from "../ids.js";
import { jsonValueSchema, type JsonValue } from "../json.js";
import { roomStatusSchema } from "../http/rooms.js";

export const memberConnectionStatusSchema = z.enum(["connected", "reconnecting", "offline"]);

export const roomMemberSchema = z.strictObject({
  memberId: memberIdSchema,
  accountId: accountIdSchema,
  displayName: z.string().min(1).max(64),
  role: z.enum(["player", "spectator"]),
  connectionStatus: memberConnectionStatusSchema,
  reconnectUntil: utcDateTimeSchema.optional(),
});

export const humanSeatOccupantSchema = z.strictObject({
  kind: z.literal("human"),
  memberId: memberIdSchema,
  accountId: accountIdSchema,
  displayName: z.string().min(1).max(64),
  ready: z.boolean(),
});

export const botSeatOccupantSchema = z.strictObject({
  kind: z.literal("bot"),
  profileId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(64),
});

export const seatOccupantSchema = z.discriminatedUnion("kind", [
  humanSeatOccupantSchema,
  botSeatOccupantSchema,
]);

export const seatControllerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human") }),
  z.strictObject({
    kind: z.literal("bot"),
    profileId: z.string().min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal("fallback"),
    reason: z.enum(["disconnect", "timeout"]),
  }),
]);

export const roomSeatSchema = z.strictObject({
  seatId: seatIdSchema,
  displayName: z.string().min(1).max(64),
  occupant: seatOccupantSchema.nullable(),
  controller: seatControllerSchema.nullable(),
});

export const chatMessageSchema = z.strictObject({
  messageId: messageIdSchema,
  memberId: memberIdSchema,
  senderName: z.string().min(1).max(64),
  sentAt: utcDateTimeSchema,
  text: z.string().min(1).max(500),
});

export const roomPermissionsSchema = z.strictObject({
  canRenameRoom: z.boolean(),
  canUpdateSettings: z.boolean(),
  claimableSeatIds: z.array(seatIdSchema),
  reclaimableSeatIds: z.array(seatIdSchema),
  canReleaseSeat: z.boolean(),
  botAddableSeatIds: z.array(seatIdSchema),
  botRemovableSeatIds: z.array(seatIdSchema),
  canSetReady: z.boolean(),
  canTransferHost: z.boolean(),
  kickableMemberIds: z.array(memberIdSchema),
  canStartMatch: z.boolean(),
  canSendChat: z.boolean(),
  canSubmitGameAction: z.boolean(),
});

export const roomSnapshotPayloadSchema = z.strictObject({
  gameId: gameIdSchema,
  room: z.strictObject({
    roomId: roomIdSchema,
    name: z.string().min(1).max(80),
    status: roomStatusSchema,
    hostMemberId: memberIdSchema,
    hasPassword: z.boolean(),
    maxSpectators: z.number().int().nonnegative(),
  }),
  members: z.array(roomMemberSchema),
  seats: z.array(roomSeatSchema),
  chat: z.array(chatMessageSchema).max(100),
  settings: jsonValueSchema,
  gameView: jsonValueSchema.nullable(),
  displayEvents: z.array(jsonValueSchema),
  permissions: roomPermissionsSchema,
});

export function createRoomSnapshotPayloadSchema<
  TSettings extends JsonValue,
  TView extends JsonValue,
  TDisplayEvent extends JsonValue,
>(schemas: {
  readonly settingsSchema: z.ZodType<TSettings>;
  readonly viewSchema: z.ZodType<TView>;
  readonly displayEventSchema: z.ZodType<TDisplayEvent>;
}) {
  return roomSnapshotPayloadSchema.extend({
    settings: schemas.settingsSchema,
    gameView: schemas.viewSchema.nullable(),
    displayEvents: z.array(schemas.displayEventSchema),
  });
}

type BaseRoomSnapshotPayload = z.infer<typeof roomSnapshotPayloadSchema>;

export type RoomSnapshotPayload<
  TSettings extends JsonValue = JsonValue,
  TView extends JsonValue = JsonValue,
  TDisplayEvent extends JsonValue = JsonValue,
> = Omit<BaseRoomSnapshotPayload, "displayEvents" | "gameView" | "settings"> & {
  readonly settings: TSettings;
  readonly gameView: TView | null;
  readonly displayEvents: readonly TDisplayEvent[];
};

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type MemberConnectionStatus = z.infer<typeof memberConnectionStatusSchema>;
export type RoomMember = z.infer<typeof roomMemberSchema>;
export type RoomPermissions = z.infer<typeof roomPermissionsSchema>;
export type RoomSeat = z.infer<typeof roomSeatSchema>;
export type SeatController = z.infer<typeof seatControllerSchema>;
export type SeatOccupant = z.infer<typeof seatOccupantSchema>;
