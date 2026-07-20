import { act, render, waitFor } from "@testing-library/react";
import { seatIdSchema } from "@tabletop/protocol";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useRoomSocket, type UseRoomSocketResult } from "./use-room-socket";

const ROOM_ID = "room-test";
const JOIN_TICKET = "A".repeat(32);
const UUIDS = {
  connection: "00000000-0000-4000-8000-000000000001",
  snapshot: "00000000-0000-4000-8000-000000000002",
} as const;

class FakeWebSocket extends EventTarget {
  static readonly CLOSED = 3;
  static readonly CLOSING = 2;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new DOMException("socket is not open");
    this.sent.push(data);
  }

  serverMessage(message: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  serverReady() {
    this.readyState = FakeWebSocket.OPEN;
    this.serverMessage(connectionReadyMessage());
  }
}

let latest: UseRoomSocketResult | undefined;

function Harness({ children }: { readonly children?: ReactNode }) {
  latest = useRoomSocket(ROOM_ID, JOIN_TICKET);
  return children ?? null;
}

describe("useRoomSocket", () => {
  const NativeWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    latest = undefined;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: FakeWebSocket,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: NativeWebSocket,
      writable: true,
    });
  });

  it("joins with a ticket, validates the plugin snapshot, then resumes after a disconnect", async () => {
    const view = render(<Harness />);
    const first = FakeWebSocket.instances[0];
    expect(first?.url).toBe(`${window.location.origin.replace("http", "ws")}/ws?protocol=1`);

    act(() => first?.serverReady());
    expect(readSentCommands(first)[0]).toMatchObject({
      payload: { joinTicket: JOIN_TICKET },
      protocol: 1,
      type: "room.join",
    });

    act(() => first?.serverMessage(roomSnapshotMessage()));
    await waitFor(() => expect(latest?.connectionStatus).toBe("connected"));
    expect(latest?.snapshot?.payload.gameId).toBe("gomoku");

    let requestId: string | null | undefined;
    act(() => {
      requestId = latest?.sendCommand({
        expectedRevision: 1,
        payload: { seatId: seatIdSchema.parse("seat-1") },
        type: "room.seat.claim",
      });
    });
    expect(requestId).toBeTruthy();
    expect(latest?.pendingCommandTypes).toEqual(["room.seat.claim"]);

    act(() => first?.serverMessage({ ...roomSnapshotMessage(), revision: 2 }));
    expect(latest?.snapshot?.revision).toBe(2);
    expect(latest?.pendingCommandTypes).toEqual(["room.seat.claim"]);

    act(() =>
      first?.serverMessage({
        causedBy: requestId,
        messageId: "00000000-0000-4000-8000-000000000003",
        payload: { stateChanged: true },
        protocol: 1,
        revision: 2,
        roomId: ROOM_ID,
        serverTime: "2026-07-16T10:00:02.000Z",
        type: "command.ack",
      }),
    );
    await waitFor(() => expect(latest?.pendingCommandTypes).toEqual([]));

    act(() => first?.close(1006, "network lost"));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const second = FakeWebSocket.instances[1];
    act(() => second?.serverReady());
    expect(readSentCommands(second)[0]).toMatchObject({
      payload: { roomId: ROOM_ID },
      protocol: 1,
      type: "room.resume",
    });

    act(() => second?.serverMessage({ ...roomSnapshotMessage(), revision: 3 }));
    await waitFor(() => expect(latest?.connectionStatus).toBe("connected"));
    expect(latest?.snapshot?.revision).toBe(3);
    view.unmount();
  });
});

function readSentCommands(socket: FakeWebSocket | undefined): unknown[] {
  return (socket?.sent ?? []).map((message) => JSON.parse(message) as unknown);
}

function connectionReadyMessage() {
  return {
    messageId: UUIDS.connection,
    payload: {
      connectionId: "connection-test",
      heartbeatIntervalMs: 20_000,
      pongTimeoutMs: 10_000,
    },
    protocol: 1,
    serverTime: "2026-07-16T10:00:00.000Z",
    type: "connection.ready",
  };
}

function roomSnapshotMessage() {
  return {
    messageId: UUIDS.snapshot,
    payload: {
      chat: [],
      displayEvents: [],
      gameId: "gomoku",
      gameView: null,
      members: [
        {
          accountId: "account-test",
          connectionStatus: "connected",
          displayName: "测试用户",
          memberId: "member-test",
          role: "spectator",
        },
      ],
      permissions: {
        botAddableSeatIds: [],
        botRemovableSeatIds: [],
        canReleaseSeat: false,
        canRenameRoom: true,
        canSendChat: true,
        canSetReady: false,
        canStartMatch: true,
        canSubmitGameAction: false,
        canTransferHost: true,
        canUpdateSettings: true,
        claimableSeatIds: ["seat-1", "seat-2"],
        kickableMemberIds: [],
        reclaimableSeatIds: [],
      },
      room: {
        hasPassword: false,
        hostMemberId: "member-test",
        maxSpectators: 10,
        name: "测试房间",
        roomId: ROOM_ID,
        status: "lobby",
      },
      seats: [
        { controller: null, displayName: "座位 1", occupant: null, seatId: "seat-1" },
        { controller: null, displayName: "座位 2", occupant: null, seatId: "seat-2" },
      ],
      settings: {
        moveTimeSeconds: 60,
        rule: "freestyle",
        timerEnabled: false,
        totalTimeMinutes: 10,
      },
    },
    protocol: 1,
    revision: 1,
    roomId: ROOM_ID,
    serverTime: "2026-07-16T10:00:01.000Z",
    type: "room.snapshot",
  };
}
