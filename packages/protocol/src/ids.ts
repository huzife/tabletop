import { z } from "zod";

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const accountIdSchema = opaqueIdSchema.brand<"AccountId">();
export const connectionIdSchema = opaqueIdSchema.brand<"ConnectionId">();
export const matchIdSchema = opaqueIdSchema.brand<"MatchId">();
export const memberIdSchema = opaqueIdSchema.brand<"MemberId">();
export const roomIdSchema = opaqueIdSchema.brand<"RoomId">();
export const seatIdSchema = opaqueIdSchema.brand<"SeatId">();
export const sessionIdSchema = opaqueIdSchema.brand<"SessionId">();

export const gameIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .brand<"GameId">();

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const correlationIdSchema = z.union([z.uuid(), ulidSchema]);

export const requestIdSchema = correlationIdSchema.brand<"RequestId">();
export const messageIdSchema = correlationIdSchema.brand<"MessageId">();

export const revisionSchema = z.number().int().nonnegative().safe();
export const utcDateTimeSchema = z.iso.datetime({ offset: true });

export const joinTicketSchema = z
  .string()
  .min(20)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/)
  .brand<"JoinTicket">();

export const inviteTokenSchema = z
  .string()
  .min(22)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/)
  .brand<"InviteToken">();

export type AccountId = z.infer<typeof accountIdSchema>;
export type ConnectionId = z.infer<typeof connectionIdSchema>;
export type GameId = z.infer<typeof gameIdSchema>;
export type InviteToken = z.infer<typeof inviteTokenSchema>;
export type JoinTicket = z.infer<typeof joinTicketSchema>;
export type MatchId = z.infer<typeof matchIdSchema>;
export type MemberId = z.infer<typeof memberIdSchema>;
export type MessageId = z.infer<typeof messageIdSchema>;
export type RequestId = z.infer<typeof requestIdSchema>;
export type RoomId = z.infer<typeof roomIdSchema>;
export type SeatId = z.infer<typeof seatIdSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
