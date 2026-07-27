import { act, render, waitFor } from "@testing-library/react";
import { matchIdSchema, seatIdSchema } from "@tabletop/protocol";
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
  bufferedAmount = 0;
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
    vi.restoreAllMocks();
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

  it("probes WebSocket again when the long-polling fallback also fails", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
      writable: true,
    });
    const view = render(<Harness />);
    const first = FakeWebSocket.instances[0];

    act(() => first?.close(1006, "handshake failed"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(125);
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(FakeWebSocket.instances).toHaveLength(2);
    random.mockRestore();
    view.unmount();
  });

  it("sends transient events outside the authoritative pending queue and coalesces rapid updates", async () => {
    const matchId = matchIdSchema.parse("match-test");
    const view = render(<Harness />);
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.serverReady());
    act(() => socket?.serverMessage({ ...roomSnapshotMessage(), matchId: "match-test" }));
    await waitFor(() => expect(latest?.connectionStatus).toBe("connected"));

    act(() => {
      latest?.sendTransientEvent(matchId, { power: 20, type: "aim.preview" });
      latest?.sendTransientEvent(matchId, { power: 40, type: "aim.preview" });
      latest?.sendTransientEvent(matchId, { power: 75, type: "aim.preview" });
    });

    expect(latest?.pendingCommandTypes).toEqual([]);
    await waitFor(() =>
      expect(
        readSentCommands(socket).filter(
          (command) =>
            typeof command === "object" &&
            command !== null &&
            "type" in command &&
            command.type === "game.transient",
        ),
      ).toHaveLength(2),
    );
    expect(readSentCommands(socket).at(-1)).toMatchObject({
      matchId: "match-test",
      payload: { power: 75, type: "aim.preview" },
      type: "game.transient",
    });
    view.unmount();
  });

  it("keeps only the latest transient event while WebSocket output is backpressured", async () => {
    const matchId = matchIdSchema.parse("match-test");
    const view = render(<Harness />);
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.serverReady());
    act(() => socket?.serverMessage({ ...roomSnapshotMessage(), matchId: "match-test" }));
    await waitFor(() => expect(latest?.connectionStatus).toBe("connected"));
    vi.useFakeTimers();
    if (socket === undefined) throw new Error("WebSocket was not created");
    socket.bufferedAmount = 128 * 1024;

    act(() => {
      latest?.sendTransientEvent(matchId, { power: 20, type: "aim.preview" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    act(() => {
      latest?.sendTransientEvent(matchId, { power: 40, type: "aim.preview" });
      latest?.sendTransientEvent(matchId, { power: 75, type: "aim.preview" });
    });

    expect(readSentCommands(socket).filter(isTransientCommand)).toEqual([]);
    socket.bufferedAmount = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(170);
    });

    expect(readSentCommands(socket).filter(isTransientCommand)).toHaveLength(1);
    expect(readSentCommands(socket).at(-1)).toMatchObject({
      payload: { power: 75, type: "aim.preview" },
      type: "game.transient",
    });
    view.unmount();
  });

  it("sends an authoritative command immediately and discards a backpressured preview", async () => {
    const matchId = matchIdSchema.parse("match-test");
    const view = render(<Harness />);
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.serverReady());
    act(() => socket?.serverMessage({ ...roomSnapshotMessage(), matchId: "match-test" }));
    await waitFor(() => expect(latest?.connectionStatus).toBe("connected"));
    vi.useFakeTimers();
    if (socket === undefined) throw new Error("WebSocket was not created");
    socket.bufferedAmount = 128 * 1024;

    act(() => {
      latest?.sendTransientEvent(matchId, { power: 75, type: "aim.preview" });
      latest?.sendCommand({
        expectedRevision: 1,
        payload: { seatId: seatIdSchema.parse("seat-1") },
        type: "room.seat.claim",
      });
    });

    expect(readSentCommands(socket).filter(isTransientCommand)).toEqual([]);
    expect(readSentCommands(socket).at(-1)).toMatchObject({ type: "room.seat.claim" });

    socket.bufferedAmount = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(readSentCommands(socket).filter(isTransientCommand)).toEqual([]);
    view.unmount();
  });

  it("retains an early transient event when the matching match snapshot arrives", async () => {
    const view = render(<Harness />);
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.serverReady());
    act(() => socket?.serverMessage(billiardsSnapshotMessage(undefined, 1)));
    await waitFor(() => expect(latest?.connectionStatus).toBe("connected"));

    act(() => socket?.serverMessage(billiardsTransientMessage("match-new", 45)));
    expect(latest?.transientEvent).toBeNull();

    act(() => socket?.serverMessage(billiardsSnapshotMessage("match-new", 2)));
    await waitFor(() =>
      expect(latest?.transientEvent).toMatchObject({
        event: { power: 45, type: "billiards.aim-preview" },
        matchId: "match-new",
      }),
    );
    view.unmount();
  });

  it("publishes a new match preview that arrives before its snapshot", async () => {
    const view = render(<Harness />);
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.serverReady());
    act(() => socket?.serverMessage(billiardsSnapshotMessage("match-old", 1)));
    await waitFor(() => expect(latest?.connectionStatus).toBe("connected"));

    act(() => socket?.serverMessage(billiardsTransientMessage("match-old", 30)));
    await waitFor(() => expect(latest?.transientEvent?.matchId).toBe("match-old"));
    act(() => socket?.serverMessage(billiardsTransientMessage("match-new", 65)));
    expect(latest?.transientEvent).toMatchObject({
      event: { power: 30 },
      matchId: "match-old",
    });

    act(() => socket?.serverMessage(billiardsSnapshotMessage("match-new", 2)));
    await waitFor(() =>
      expect(latest?.transientEvent).toMatchObject({
        event: { power: 65, type: "billiards.aim-preview" },
        matchId: "match-new",
      }),
    );
    view.unmount();
  });

  it("does not replace the current match preview with an unrelated match event", async () => {
    const view = render(<Harness />);
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.serverReady());
    act(() => socket?.serverMessage(billiardsSnapshotMessage("match-old", 1)));
    await waitFor(() => expect(latest?.connectionStatus).toBe("connected"));

    act(() => socket?.serverMessage(billiardsTransientMessage("match-old", 30)));
    await waitFor(() => expect(latest?.transientEvent?.matchId).toBe("match-old"));
    act(() => socket?.serverMessage(billiardsTransientMessage("match-unrelated", 90)));

    expect(latest?.transientEvent).toMatchObject({
      event: { power: 30, type: "billiards.aim-preview" },
      matchId: "match-old",
    });
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
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(latest?.connectionStatus).toBe("connected");
    expect(commands[0]).toMatchObject({ type: "room.join" });
    view.unmount();
  });

  it("abandons a silent WebSocket after an application heartbeat timeout", async () => {
    const { commands } = installLongPollingFetch();
    vi.useFakeTimers();
    const view = render(<Harness />);
    const socket = FakeWebSocket.instances[0];

    act(() => socket?.serverReady());
    act(() => socket?.serverMessage(roomSnapshotMessage()));
    expect(latest?.connectionStatus).toBe("connected");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(readSentCommands(socket).at(-1)).toMatchObject({
      payload: {},
      type: "connection.ping",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_250);
    });

    expect(latest?.connectionStatus).toBe("connected");
    expect(commands[0]).toMatchObject({
      payload: { roomId: ROOM_ID },
      type: "room.resume",
    });
    view.unmount();
  });

  it("keeps the WebSocket when the application heartbeat is acknowledged", async () => {
    vi.useFakeTimers();
    const view = render(<Harness />);
    const socket = FakeWebSocket.instances[0];

    act(() => socket?.serverReady());
    act(() => socket?.serverMessage(roomSnapshotMessage()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    const ping = readSentCommands(socket).at(-1) as
      { readonly requestId?: string; readonly type?: string } | undefined;
    expect(ping).toMatchObject({ type: "connection.ping" });
    if (ping?.requestId === undefined) throw new Error("应用心跳缺少 requestId");

    act(() =>
      socket?.serverMessage({
        causedBy: ping.requestId,
        messageId: "00000000-0000-4000-8000-000000000005",
        payload: {},
        protocol: 1,
        serverTime: "2026-07-16T10:00:21.000Z",
        type: "connection.pong",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(latest?.connectionStatus).toBe("connected");
    expect(latest?.pendingCommandTypes).toEqual([]);
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

function isTransientCommand(command: unknown): boolean {
  return (
    typeof command === "object" &&
    command !== null &&
    "type" in command &&
    command.type === "game.transient"
  );
}

function billiardsSnapshotMessage(matchId: string | undefined, revision: number) {
  const snapshot = roomSnapshotMessage();
  return {
    ...snapshot,
    ...(matchId === undefined ? {} : { matchId }),
    payload: {
      ...snapshot.payload,
      gameId: "billiards",
      settings: { mode: "chinese-eight-ball" },
    },
    revision,
  };
}

function billiardsTransientMessage(matchId: string, power: number) {
  return {
    matchId,
    messageId: "00000000-0000-4000-8000-000000000004",
    payload: {
      event: {
        angle: 0.4,
        elevation: 12,
        power,
        shotNumber: 0,
        tip: { x: 0.2, y: -0.1 },
        type: "billiards.aim-preview",
      },
      senderSeatId: "seat-2",
    },
    protocol: 1,
    roomId: ROOM_ID,
    serverTime: "2026-07-16T10:00:01.500Z",
    type: "game.transient",
  };
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
