import type { MatchId, MessageId, RequestId, RoomId } from "../ids.js";

export interface ClientCommandEnvelope<TType extends string = string, TPayload = unknown> {
  protocol: 1;
  requestId: RequestId;
  type: TType;
  roomId?: RoomId;
  matchId?: MatchId;
  expectedRevision?: number;
  payload: TPayload;
}

export interface ServerMessageEnvelope<TType extends string = string, TPayload = unknown> {
  protocol: 1;
  messageId: MessageId;
  type: TType;
  roomId?: RoomId;
  matchId?: MatchId;
  revision?: number;
  causedBy?: RequestId;
  serverTime: string;
  payload: TPayload;
}
