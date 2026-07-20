import { z } from "zod";

import {
  accountIdSchema,
  joinTicketSchema,
  matchIdSchema,
  memberIdSchema,
  requestIdSchema,
  revisionSchema,
  roomIdSchema,
  seatIdSchema,
} from "../ids.js";
import { jsonValueSchema } from "../json.js";

const clientEnvelopeFields = {
  protocol: z.literal(1),
  requestId: requestIdSchema,
} as const;

const roomCommandFields = {
  ...clientEnvelopeFields,
  roomId: roomIdSchema,
} as const;

const revisionedRoomCommandFields = {
  ...roomCommandFields,
  expectedRevision: revisionSchema,
} as const;

const emptyPayloadSchema = z.strictObject({});
const gameActionPayloadSchema = z
  .object({
    type: z.string().min(1).max(96),
  })
  .catchall(jsonValueSchema);

export const roomJoinCommandSchema = z.strictObject({
  ...clientEnvelopeFields,
  type: z.literal("room.join"),
  payload: z.strictObject({
    joinTicket: joinTicketSchema,
  }),
});

export const roomResumeCommandSchema = z.strictObject({
  ...clientEnvelopeFields,
  type: z.literal("room.resume"),
  payload: z.strictObject({
    roomId: roomIdSchema,
  }),
});

export const roomLeaveCommandSchema = z.strictObject({
  ...roomCommandFields,
  type: z.literal("room.leave"),
  payload: emptyPayloadSchema,
});

export const roomRenameCommandSchema = z.strictObject({
  ...revisionedRoomCommandFields,
  type: z.literal("room.rename"),
  payload: z.strictObject({
    name: z.string().trim().min(1).max(80),
  }),
});

export const roomSettingsUpdateCommandSchema = z.strictObject({
  ...revisionedRoomCommandFields,
  type: z.literal("room.settings.update"),
  payload: z.strictObject({
    settings: jsonValueSchema,
  }),
});

export const roomSeatClaimCommandSchema = z.strictObject({
  ...revisionedRoomCommandFields,
  type: z.literal("room.seat.claim"),
  payload: z.strictObject({
    seatId: seatIdSchema,
  }),
});

export const roomSeatReclaimCommandSchema = z.strictObject({
  ...revisionedRoomCommandFields,
  type: z.literal("room.seat.reclaim"),
  payload: z.strictObject({
    seatId: seatIdSchema,
  }),
});

export const roomSeatReleaseCommandSchema = z.strictObject({
  ...revisionedRoomCommandFields,
  type: z.literal("room.seat.release"),
  payload: emptyPayloadSchema,
});

export const roomBotAddCommandSchema = z.strictObject({
  ...revisionedRoomCommandFields,
  type: z.literal("room.bot.add"),
  payload: z.strictObject({
    seatId: seatIdSchema,
    profileId: z.string().min(1).max(64),
  }),
});

export const roomBotRemoveCommandSchema = z.strictObject({
  ...revisionedRoomCommandFields,
  type: z.literal("room.bot.remove"),
  payload: z.strictObject({
    seatId: seatIdSchema,
  }),
});

export const roomReadySetCommandSchema = z.strictObject({
  ...revisionedRoomCommandFields,
  type: z.literal("room.ready.set"),
  payload: z.strictObject({
    ready: z.boolean(),
  }),
});

export const roomHostTransferCommandSchema = z.strictObject({
  ...revisionedRoomCommandFields,
  type: z.literal("room.host.transfer"),
  payload: z.strictObject({
    accountId: accountIdSchema,
  }),
});

export const roomMemberKickCommandSchema = z.strictObject({
  ...revisionedRoomCommandFields,
  type: z.literal("room.member.kick"),
  payload: z.strictObject({
    memberId: memberIdSchema,
  }),
});

export const roomMatchStartCommandSchema = z.strictObject({
  ...revisionedRoomCommandFields,
  type: z.literal("room.match.start"),
  payload: emptyPayloadSchema,
});

export const chatSendCommandSchema = z.strictObject({
  ...roomCommandFields,
  type: z.literal("chat.send"),
  payload: z.strictObject({
    text: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => value.trim().length > 0, "chat text is empty"),
  }),
});

export const gameActionCommandSchema = z.strictObject({
  ...revisionedRoomCommandFields,
  matchId: matchIdSchema,
  type: z.literal("game.action"),
  payload: gameActionPayloadSchema,
});

export const clientCommandSchema = z.discriminatedUnion("type", [
  roomJoinCommandSchema,
  roomResumeCommandSchema,
  roomLeaveCommandSchema,
  roomRenameCommandSchema,
  roomSettingsUpdateCommandSchema,
  roomSeatClaimCommandSchema,
  roomSeatReclaimCommandSchema,
  roomSeatReleaseCommandSchema,
  roomBotAddCommandSchema,
  roomBotRemoveCommandSchema,
  roomReadySetCommandSchema,
  roomHostTransferCommandSchema,
  roomMemberKickCommandSchema,
  roomMatchStartCommandSchema,
  chatSendCommandSchema,
  gameActionCommandSchema,
]);

export type ChatSendCommand = z.infer<typeof chatSendCommandSchema>;
export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type GameActionCommand = z.infer<typeof gameActionCommandSchema>;
export type RoomJoinCommand = z.infer<typeof roomJoinCommandSchema>;
export type RoomResumeCommand = z.infer<typeof roomResumeCommandSchema>;
