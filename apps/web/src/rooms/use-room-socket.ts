import {
  clientCommandSchema,
  createRoomSnapshotPayloadSchema,
  roomIdSchema,
  serverMessageSchema,
  type ClientCommand,
  type JsonObject,
  type RequestId,
  type RoomJoinCommand,
  type RoomResumeCommand,
  type RoomSnapshotMessage,
} from "@tabletop/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import { webGameRegistry } from "../games/registry";
import { consumeStoredJoinTicket } from "./entry-context";

const RECONNECT_WINDOW_MS = 30_000;
const RECONNECT_DELAYS_MS = [0, 500, 1_000, 2_000, 3_000, 5_000] as const;

type ManagedCommand = Exclude<ClientCommand, RoomJoinCommand | RoomResumeCommand>;
type StripManagedEnvelope<T> = T extends ManagedCommand
  ? Omit<T, "protocol" | "requestId" | "roomId">
  : never;

export type RoomCommandInput = StripManagedEnvelope<ManagedCommand>;
export type RoomConnectionStatus =
  "connecting" | "connected" | "reconnecting" | "offline" | "closed";

export interface RoomSocketError {
  readonly code: string;
  readonly commandType?: ClientCommand["type"];
  readonly details: JsonObject;
  readonly message: string;
}

export interface ParsedRoomSnapshot extends RoomSnapshotMessage {
  readonly payload: RoomSnapshotMessage["payload"];
}

export interface UseRoomSocketResult {
  readonly clearError: () => void;
  readonly connectionStatus: RoomConnectionStatus;
  readonly error: RoomSocketError | null;
  readonly pendingCommandTypes: readonly ClientCommand["type"][];
  readonly retry: () => void;
  readonly sendCommand: (command: RoomCommandInput) => RequestId | null;
  readonly snapshot: ParsedRoomSnapshot | null;
}

function createRequestId(): RequestId {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-") as RequestId;
}

function webSocketUrl(): string {
  const url = new URL("/ws?protocol=1", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function socketError(
  code: string,
  message: string,
  options: { readonly commandType?: ClientCommand["type"]; readonly details?: JsonObject } = {},
): RoomSocketError {
  return {
    code,
    ...(options.commandType === undefined ? {} : { commandType: options.commandType }),
    details: options.details ?? {},
    message,
  };
}

export function useRoomSocket(
  roomIdInput: string,
  initialJoinTicket: string | undefined,
): UseRoomSocketResult {
  const parsedRoomId = roomIdSchema.safeParse(roomIdInput);
  const roomId = parsedRoomId.success ? parsedRoomId.data : null;
  const [connectionStatus, setConnectionStatus] = useState<RoomConnectionStatus>("connecting");
  const [error, setError] = useState<RoomSocketError | null>(null);
  const [pendingCommands, setPendingCommands] = useState<
    ReadonlyMap<RequestId, ClientCommand["type"]>
  >(new Map());
  const [snapshot, setSnapshot] = useState<ParsedRoomSnapshot | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const initialJoinCommandRef = useRef<ClientCommand | null>(null);
  const entryStateRef = useRef({
    ambiguousJoin: false,
    established: false,
    joinAttempted: false,
    joinInFlight: false,
    ticketFallbackAttempted: false,
  });
  const sendCommandRef = useRef<(command: RoomCommandInput) => RequestId | null>(() => null);
  const retryRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (roomId === null) {
      setConnectionStatus("offline");
      setError(socketError("ROOM_NOT_FOUND", "房间地址无效"));
      return;
    }

    let disposed = false;
    let intentionalClose = false;
    let reconnectAttempt = 0;
    let reconnectDeadline = 0;
    let reconnectExpiryTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let socket: WebSocket | null = null;
    const sentCommands = new Map<RequestId, ClientCommand>();
    const pending = new Map<RequestId, ClientCommand["type"]>();
    const entryState = entryStateRef.current;

    const clearReconnectExpiry = () => {
      if (reconnectExpiryTimer === undefined) return;
      window.clearTimeout(reconnectExpiryTimer);
      reconnectExpiryTimer = undefined;
    };
    const ensureReconnectDeadline = () => {
      if (reconnectDeadline === 0) reconnectDeadline = Date.now() + RECONNECT_WINDOW_MS;
      clearReconnectExpiry();
      reconnectExpiryTimer = window.setTimeout(
        () => {
          if (disposed || intentionalClose || reconnectDeadline === 0) return;
          reconnectDeadline = 0;
          intentionalClose = true;
          clearPending();
          setConnectionStatus("offline");
          setError(socketError("SOCKET_RECONNECT_EXPIRED", "30 秒内未能恢复房间连接"));
          socket?.close(4000, "重连窗口已结束");
        },
        Math.max(0, reconnectDeadline - Date.now()),
      );
    };

    const publishPending = () => setPendingCommands(new Map(pending));
    const removePending = (requestId: RequestId) => {
      if (!pending.delete(requestId)) return;
      publishPending();
    };
    const clearPending = () => {
      if (pending.size === 0) return;
      pending.clear();
      publishPending();
    };
    const rememberCommand = (command: ClientCommand, userCommand: boolean) => {
      sentCommands.set(command.requestId, command);
      if (sentCommands.size > 128) {
        const oldest = sentCommands.keys().next().value;
        if (oldest !== undefined) sentCommands.delete(oldest);
      }
      if (userCommand) {
        pending.set(command.requestId, command.type);
        publishPending();
      }
    };
    const sendParsed = (command: ClientCommand, userCommand: boolean): boolean => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      rememberCommand(command, userCommand);
      socket.send(JSON.stringify(command));
      return true;
    };
    const sendResume = () => {
      ensureReconnectDeadline();
      const command = clientCommandSchema.parse({
        payload: { roomId },
        protocol: 1,
        requestId: createRequestId(),
        type: "room.resume",
      });
      sendParsed(command, false);
    };
    const sendJoin = (fallbackAfterAmbiguousResume: boolean) => {
      if (initialJoinTicket === undefined) return false;
      const command =
        initialJoinCommandRef.current ??
        clientCommandSchema.parse({
          payload: { joinTicket: initialJoinTicket },
          protocol: 1,
          requestId: createRequestId(),
          type: "room.join",
        });
      initialJoinCommandRef.current = command;
      entryState.joinAttempted = true;
      entryState.joinInFlight = true;
      if (fallbackAfterAmbiguousResume) entryState.ticketFallbackAttempted = true;
      consumeStoredJoinTicket(roomId);
      return sendParsed(command, false);
    };
    const sendEntryCommand = () => {
      if (initialJoinTicket !== undefined && !entryState.joinAttempted) {
        sendJoin(false);
        return;
      }
      entryState.joinAttempted = true;
      sendResume();
    };

    const failProtocol = (message: string) => {
      intentionalClose = true;
      setError(socketError("SOCKET_PROTOCOL_ERROR", message));
      setConnectionStatus("offline");
      socket?.close(1002, "协议消息无效");
    };

    const parseSnapshot = (
      message: Extract<ReturnType<typeof serverMessageSchema.parse>, { type: "room.snapshot" }>,
    ): ParsedRoomSnapshot | null => {
      if (message.roomId !== roomId) {
        failProtocol("服务端返回了其他房间的状态");
        return null;
      }
      const gameModule = webGameRegistry.get(message.payload.gameId);
      if (gameModule === undefined) {
        failProtocol("浏览器未安装该房间所需的游戏插件");
        return null;
      }
      const payload = createRoomSnapshotPayloadSchema({
        displayEventSchema: gameModule.shared.displayEventSchema,
        settingsSchema: gameModule.shared.settings.schema,
        viewSchema: gameModule.shared.viewSchema,
      }).safeParse(message.payload);
      if (!payload.success) {
        failProtocol("游戏插件拒绝了服务端返回的房间状态");
        return null;
      }
      return { ...message, payload: payload.data };
    };

    const handleServerMessage = (raw: string) => {
      let json: unknown;
      try {
        json = JSON.parse(raw) as unknown;
      } catch {
        failProtocol("服务端返回的消息不是有效 JSON");
        return;
      }
      const parsed = serverMessageSchema.safeParse(json);
      if (!parsed.success) {
        failProtocol("服务端返回的消息不符合协议版本 1");
        return;
      }
      const message = parsed.data;

      switch (message.type) {
        case "connection.ready":
          sendEntryCommand();
          break;
        case "command.ack":
          removePending(message.causedBy);
          sentCommands.delete(message.causedBy);
          break;
        case "command.error": {
          const failedCommand = sentCommands.get(message.causedBy);
          removePending(message.causedBy);
          sentCommands.delete(message.causedBy);

          if (failedCommand?.type === "room.join") {
            entryState.joinInFlight = false;
            entryState.ambiguousJoin = false;
          }

          if (
            failedCommand?.type === "room.resume" &&
            message.payload.code === "ROOM_INVALID_STATE" &&
            Date.now() < reconnectDeadline &&
            socket?.readyState === WebSocket.OPEN
          ) {
            window.setTimeout(sendResume, 250);
            break;
          }
          if (
            failedCommand?.type === "room.resume" &&
            message.payload.code === "ROOM_PERMISSION_DENIED" &&
            entryState.ambiguousJoin &&
            !entryState.ticketFallbackAttempted &&
            socket?.readyState === WebSocket.OPEN
          ) {
            entryState.ambiguousJoin = false;
            sendJoin(true);
            break;
          }
          if (message.payload.resyncRequired && failedCommand !== undefined) {
            // The gateway treats a repeated request ID as a snapshot request without applying it twice.
            socket?.send(JSON.stringify(failedCommand));
          }
          const commandError = socketError(message.payload.code, message.payload.message, {
            ...(failedCommand === undefined ? {} : { commandType: failedCommand.type }),
            details: message.payload.details,
          });
          setError(commandError);
          if (failedCommand?.type === "room.join" || failedCommand?.type === "room.resume") {
            intentionalClose = true;
            setConnectionStatus("offline");
            socket?.close(1000, "无法进入房间");
          }
          break;
        }
        case "room.snapshot": {
          const nextSnapshot = parseSnapshot(message);
          if (nextSnapshot === null) return;
          setSnapshot((current) =>
            current !== null && current.revision >= nextSnapshot.revision ? current : nextSnapshot,
          );
          if (message.causedBy !== undefined) {
            removePending(message.causedBy);
            sentCommands.delete(message.causedBy);
          }
          entryState.established = true;
          entryState.joinInFlight = false;
          entryState.ambiguousJoin = false;
          reconnectAttempt = 0;
          clearReconnectExpiry();
          reconnectDeadline = 0;
          setConnectionStatus("connected");
          setError((current) => (current?.code.startsWith("SOCKET_") === true ? null : current));
          break;
        }
        case "room.closed":
          intentionalClose = true;
          clearPending();
          setConnectionStatus("closed");
          setError(socketError("ROOM_CLOSED", message.payload.message));
          socket?.close(1000, "房间已关闭");
          break;
        case "room.connection.changed":
          // A complete, viewer-specific snapshot follows every runtime connection transition.
          break;
        case "service.status.changed":
          if (!message.payload.enabled) {
            setError(
              socketError(
                message.payload.scope === "site" ? "SITE_DISABLED" : "GAME_SERVICE_DISABLED",
                message.payload.scope === "site" ? "网站正在维护" : "当前游戏服务已停止",
              ),
            );
          }
          break;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || intentionalClose) return;
      const now = Date.now();
      ensureReconnectDeadline();
      if (now >= reconnectDeadline) {
        intentionalClose = true;
        clearReconnectExpiry();
        reconnectDeadline = 0;
        setConnectionStatus("offline");
        setError(socketError("SOCKET_RECONNECT_EXPIRED", "30 秒内未能恢复房间连接"));
        return;
      }
      const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
      reconnectAttempt += 1;
      setConnectionStatus("reconnecting");
      reconnectTimer = window.setTimeout(connect, delay);
    };

    function connect() {
      if (disposed || intentionalClose) return;
      if (socket !== null && socket.readyState !== WebSocket.CLOSED) return;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      let connectedSocket: WebSocket;
      try {
        connectedSocket = new WebSocket(webSocketUrl());
        socket = connectedSocket;
        socketRef.current = connectedSocket;
      } catch {
        scheduleReconnect();
        return;
      }
      connectedSocket.addEventListener("message", (event) => {
        if (socket !== connectedSocket) return;
        if (typeof event.data === "string") {
          handleServerMessage(event.data);
          return;
        }
        if (event.data instanceof Blob) {
          void event.data
            .text()
            .then((raw) => {
              if (socket === connectedSocket) handleServerMessage(raw);
            })
            .catch(() => {
              if (socket === connectedSocket) failProtocol("无法读取服务端消息");
            });
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          handleServerMessage(new TextDecoder().decode(event.data));
          return;
        }
        failProtocol("服务端返回了不支持的消息类型");
      });
      connectedSocket.addEventListener("close", (event) => {
        if (socketRef.current === connectedSocket) socketRef.current = null;
        if (socket !== connectedSocket) return;
        socket = null;
        clearPending();
        if (entryState.joinInFlight && !entryState.established) {
          entryState.joinInFlight = false;
          entryState.ambiguousJoin = true;
        }
        if (disposed || intentionalClose) return;
        if (event.code === 4001 || event.code === 4003 || event.code === 4004) {
          intentionalClose = true;
          setConnectionStatus("offline");
          setError(
            socketError(
              event.code === 4001
                ? "CONNECTION_ROOM_CONFLICT"
                : event.code === 4003
                  ? "ROOM_PERMISSION_DENIED"
                  : "AUTH_SESSION_EXPIRED",
              event.reason ||
                (event.code === 4001
                  ? "房间控制已转移到同一设备的其他页面"
                  : event.code === 4003
                    ? "已被房主移出房间"
                    : "登录会话已失效"),
            ),
          );
          return;
        }
        scheduleReconnect();
      });
      connectedSocket.addEventListener("error", () => {
        // Browsers intentionally hide handshake details; close drives the bounded retry loop.
      });
    }

    sendCommandRef.current = (input) => {
      if (intentionalClose || socket?.readyState !== WebSocket.OPEN) return null;
      const requestId = createRequestId();
      const parsed = clientCommandSchema.safeParse({
        ...input,
        protocol: 1,
        requestId,
        roomId,
      });
      if (
        !parsed.success ||
        parsed.data.type === "room.join" ||
        parsed.data.type === "room.resume"
      ) {
        setError(socketError("VALIDATION_FAILED", "房间命令格式无效"));
        return null;
      }
      if (!sendParsed(parsed.data, true)) return null;
      setError(null);
      return requestId;
    };
    retryRef.current = () => {
      intentionalClose = false;
      reconnectAttempt = 0;
      reconnectDeadline = Date.now() + RECONNECT_WINDOW_MS;
      ensureReconnectDeadline();
      setError(null);
      setConnectionStatus("reconnecting");
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
        socket.close(4000, "重新连接");
        return;
      }
      connect();
    };

    const handleOnline = () => connect();
    window.addEventListener("online", handleOnline);
    connect();

    return () => {
      disposed = true;
      intentionalClose = true;
      if (entryState.joinInFlight && !entryState.established) {
        entryState.joinInFlight = false;
        entryState.ambiguousJoin = true;
      }
      window.removeEventListener("online", handleOnline);
      clearReconnectExpiry();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      clearPending();
      socket?.close(1000, "页面已离开");
      if (socketRef.current === socket) socketRef.current = null;
      sendCommandRef.current = () => null;
      retryRef.current = () => undefined;
    };
  }, [initialJoinTicket, roomId]);

  const sendCommand = useCallback(
    (command: RoomCommandInput) => sendCommandRef.current(command),
    [],
  );
  const retry = useCallback(() => retryRef.current(), []);
  const clearError = useCallback(() => setError(null), []);

  return {
    clearError,
    connectionStatus,
    error,
    pendingCommandTypes: [...pendingCommands.values()],
    retry,
    sendCommand,
    snapshot,
  };
}
