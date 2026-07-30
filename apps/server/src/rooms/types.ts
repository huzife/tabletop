import type { HostedGameServerModuleV1 } from "@tabletop/game-sdk/server";
import type {
  AccountId,
  JsonValue,
  MatchId,
  MemberId,
  RoomId,
  SeatId,
  SessionId,
} from "@tabletop/protocol";

export type InternalRoomStatus = "lobby" | "playing" | "post_match";

export interface RoomMemberState {
  readonly memberId: MemberId;
  readonly accountId: AccountId;
  sessionId: SessionId;
  readonly displayName: string;
  readonly joinedAt: number;
  role: "player" | "spectator";
  connectionStatus: "connected" | "reconnecting";
  connectionId?: string;
  reconnectUntil?: number;
}

export interface HumanSeatOccupantState {
  readonly kind: "human";
  accountId: AccountId;
  displayName: string;
  memberId: MemberId;
  ready: boolean;
}

export interface BotSeatOccupantState {
  readonly kind: "bot";
  readonly displayName: string;
  readonly profileId: string;
}

export type SeatOccupantState = HumanSeatOccupantState | BotSeatOccupantState;

export type SeatControllerState =
  | { readonly kind: "human" }
  | { readonly kind: "bot"; readonly profileId: string }
  | { readonly kind: "fallback"; readonly reason: "disconnect" | "timeout" };

export interface RoomSeatState {
  readonly seatId: SeatId;
  readonly displayName: string;
  occupant: SeatOccupantState | null;
  controller: SeatControllerState | null;
  reclaimable: boolean;
}

export interface ChatMessageState {
  readonly messageId: string;
  readonly memberId: MemberId;
  readonly senderName: string;
  readonly sentAt: number;
  readonly text: string;
}

export interface MatchRuntimeState {
  readonly matchId: MatchId;
  state: object;
}

export interface RoomState {
  readonly roomId: RoomId;
  readonly gameId: string;
  readonly createdAt: number;
  readonly creatorAccountId: AccountId;
  readonly inviteToken: string;
  readonly practice: boolean;
  readonly game: HostedGameServerModuleV1;
  name: string;
  passwordHash?: string;
  hostMemberId: MemberId;
  status: InternalRoomStatus;
  settings: JsonValue;
  revision: number;
  members: Map<MemberId, RoomMemberState>;
  seats: RoomSeatState[];
  chat: ChatMessageState[];
  match?: MatchRuntimeState;
  previousSummary?: { readonly matchId: MatchId; readonly publicSummary?: JsonValue };
}

export interface RoomPublisher {
  publishSnapshot(room: RoomRuntimeLike, events: readonly JsonValue[]): void;
  publishClosed(roomId: RoomId, reason: string, message: string): void;
  disconnectConnection(connectionId: string, code: number, reason: string): void;
  disconnectMember(memberId: MemberId, code: number, reason: string): void;
}

export interface RoomRuntimeLike {
  readonly state: RoomState;
}
