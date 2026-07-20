import { inviteTokenSchema, joinTicketSchema, roomIdSchema } from "@tabletop/protocol";

export interface RoomEntryContext {
  readonly inviteUrl?: string;
  readonly joinTicket?: string;
}

interface RoomNavigationState {
  readonly inviteToken?: unknown;
  readonly inviteUrl?: unknown;
  readonly joinTicket?: unknown;
}

function storageKey(roomId: string, field: "invite-url" | "join-ticket"): string {
  return `tabletop.room.${roomId}.${field}`;
}

function readStored(key: string): string | undefined {
  try {
    return window.sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function store(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // A blocked session store must not prevent joining the room in the current navigation.
  }
}

function removeStored(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // The in-memory connection state remains authoritative for this page instance.
  }
}

function navigationState(value: unknown): RoomNavigationState {
  return typeof value === "object" && value !== null ? (value as RoomNavigationState) : {};
}

function normalizeInviteUrl(state: RoomNavigationState): string | undefined {
  const candidate =
    typeof state.inviteUrl === "string"
      ? state.inviteUrl
      : typeof state.inviteToken === "string"
        ? `/invite/${encodeURIComponent(state.inviteToken)}`
        : undefined;
  if (candidate === undefined) return undefined;

  try {
    const url = new URL(candidate, window.location.origin);
    const match = /^\/invite\/([^/]+)$/.exec(url.pathname);
    const token = match?.[1];
    if (
      url.origin !== window.location.origin ||
      token === undefined ||
      !inviteTokenSchema.safeParse(decodeURIComponent(token)).success
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

export function captureRoomEntryContext(
  roomIdInput: string,
  stateInput: unknown,
): RoomEntryContext {
  const parsedRoomId = roomIdSchema.safeParse(roomIdInput);
  if (!parsedRoomId.success) return {};

  const roomId = parsedRoomId.data;
  const state = navigationState(stateInput);
  const stateTicket = joinTicketSchema.safeParse(state.joinTicket);
  const storedTicket = joinTicketSchema.safeParse(readStored(storageKey(roomId, "join-ticket")));
  const joinTicket = stateTicket.success
    ? stateTicket.data
    : storedTicket.success
      ? storedTicket.data
      : undefined;
  const stateInviteUrl = normalizeInviteUrl(state);
  const storedInviteUrl = normalizeInviteUrl({
    inviteUrl: readStored(storageKey(roomId, "invite-url")),
  });
  const inviteUrl = stateInviteUrl ?? storedInviteUrl;

  if (joinTicket !== undefined) store(storageKey(roomId, "join-ticket"), joinTicket);
  if (stateInviteUrl !== undefined) store(storageKey(roomId, "invite-url"), stateInviteUrl);

  return {
    ...(inviteUrl === undefined ? {} : { inviteUrl }),
    ...(joinTicket === undefined ? {} : { joinTicket }),
  };
}

export function consumeStoredJoinTicket(roomId: string): void {
  removeStored(storageKey(roomId, "join-ticket"));
}

export function clearRoomEntryContext(roomId: string): void {
  removeStored(storageKey(roomId, "invite-url"));
  removeStored(storageKey(roomId, "join-ticket"));
}
