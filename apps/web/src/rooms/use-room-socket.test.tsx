import { act, render, waitFor } from "@testing-library/react";
import { seatIdSchema } from "@tabletop/protocol";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  const NativeFetch = globalThis.fetch;
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
    vi.useRealTimers();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: NativeFetch,
      writable: true,
    });
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

  it("falls back to HTTP long polling when the initial WebSocket handshake fails", async () => {
    const { commands } = installLongPollingFetch();

    const view = render(<Harness />);
    const first = FakeWebSocket.instances[0];
    act(() => first?.close(1006, "handshake failed"));

    await waitFor(() => expect(latest?.connectionStatus).toBe("connected"));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      payload: { joinTicket: JOIN_TICKET },
      protocol: 1,
      type: "room.join",
    });

    act(() => {
      latest?.sendCommand({
        expectedRevision: 1,
        payload: { seatId: seatIdSchema.parse("seat-1") },
        type: "room.seat.claim",
      });
    });
    await waitFor(() => expect(commands).toHaveLength(2));
    expect(commands[1]).toMatchObject({ type: "room.seat.claim" });
    view.unmount();
  });

  it("uses HTTP long polling when the browser has no WebSocket implementation", async () => {
    const { commands } = installLongPollingFetch();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: undefined,
      writable: true,
    });

    const view = render(<Harness />);

    await waitFor(() => expect(latest?.connectionStatus).toBe("connected"));
    expect(commands[0]).toMatchObject({
      payload: { joinTicket: JOIN_TICKET },
      protocol: 1,
      type: "room.join",
    });
    view.unmount();
  });

  it("abandons a WebSocket that never produces a room snapshot", async () => {
    const { commands } = installLongPollingFetch();
    vi.useFakeTimers();
    const view = render(<Harness />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(latest?.connectionStatus).toBe("connected");
    expect(commands[0]).toMatchObject({ type: "room.join" });
    view.unmount();
  });
});

function installLongPollingFetch() {
  const commands: unknown[] = [];
  let pollCount = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === "/api/v1/room-connections" && init?.method === "POST") {
      return jsonResponse(
        {
          connectionId: "connection-polling",
          messages: [
            {
              ...connectionReadyMessage(),
              payload: {
                ...connectionReadyMessage().payload,
                connectionId: "connection-polling",
              },
            },
          ],
        },
        201,
      );
    }
    if (url.pathname.endsWith("/commands") && init?.method === "POST") {
      commands.push(JSON.parse(String(init.body)) as unknown);
      return jsonResponse({ accepted: true }, 202);
    }
    if (url.pathname.endsWith("/poll") && init?.method === "POST") {
      pollCount += 1;
      if (pollCount === 1) {
        return jsonResponse({ messages: [roomSnapshotMessage()] });
      }
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }
    if (url.pathname.startsWith("/api/v1/room-connections/") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchMock,
    writable: true,
  });
  return { commands, fetchMock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

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
