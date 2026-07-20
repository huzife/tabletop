import { beforeEach, describe, expect, it } from "vitest";

import {
  captureRoomEntryContext,
  clearRoomEntryContext,
  consumeStoredJoinTicket,
} from "./entry-context";

const ROOM_ID = "room-test";
const JOIN_TICKET = "A".repeat(32);
const INVITE_TOKEN = "B".repeat(32);

describe("room entry context", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("captures navigation credentials for a refresh before the join command is sent", () => {
    const first = captureRoomEntryContext(ROOM_ID, {
      inviteUrl: `${window.location.origin}/invite/${INVITE_TOKEN}`,
      joinTicket: JOIN_TICKET,
    });
    expect(first).toEqual({
      inviteUrl: `${window.location.origin}/invite/${INVITE_TOKEN}`,
      joinTicket: JOIN_TICKET,
    });

    expect(captureRoomEntryContext(ROOM_ID, null)).toEqual(first);
  });

  it("consumes the one-time ticket while retaining the reusable invite URL", () => {
    captureRoomEntryContext(ROOM_ID, {
      inviteToken: INVITE_TOKEN,
      joinTicket: JOIN_TICKET,
    });
    consumeStoredJoinTicket(ROOM_ID);

    expect(captureRoomEntryContext(ROOM_ID, null)).toEqual({
      inviteUrl: `${window.location.origin}/invite/${INVITE_TOKEN}`,
    });
    clearRoomEntryContext(ROOM_ID);
    expect(captureRoomEntryContext(ROOM_ID, null)).toEqual({});
  });

  it("rejects external or malformed invite URLs from navigation and storage", () => {
    expect(
      captureRoomEntryContext(ROOM_ID, {
        inviteUrl: `https://example.invalid/invite/${INVITE_TOKEN}`,
      }),
    ).toEqual({});

    window.sessionStorage.setItem(
      `tabletop.room.${ROOM_ID}.invite-url`,
      `${window.location.origin}/not-an-invite/${INVITE_TOKEN}`,
    );
    expect(captureRoomEntryContext(ROOM_ID, null)).toEqual({});
  });
});
