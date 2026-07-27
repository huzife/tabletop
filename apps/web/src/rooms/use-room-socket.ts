import {
  clientCommandSchema,
  createRoomSnapshotPayloadSchema,
  roomIdSchema,
  serverMessageSchema,
  type ClientCommand,
  type ConnectionPingCommand,
  type GameTransientCommand,
  type JsonObject,
  type MatchId,
  type RequestId,
  type RoomJoinCommand,
  type RoomResumeCommand,
  type RoomSnapshotMessage,
  type SeatId,
} from "@tabletop/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import { webGameRegistry } from "../games/registry";
import { consumeStoredJoinTicket } from "./entry-context";
import { RoomLongPollingTransport, type LongPollingTransportClose } from "./long-polling-transport";

const CLIENT_RECOVERY_TIMEOUT_MS = 70_000;
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
const TRANSIENT_BACKPRESSURE_RETRY_MS = 250;
const WEB_SOCKET_TRANSIENT_BACKPRESSURE_BYTES = 64 * 1024;
const WEB_SOCKET_ESTABLISH_TIMEOUT_MS = 10_000;

type ManagedCommand = Exclude<
  ClientCommand,
  ConnectionPingCommand | RoomJoinCommand | RoomResumeCommand | GameTransientCommand
>;
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

export interface ParsedGameTransientEvent {
  readonly event: GameTransientCommand["payload"];
  readonly matchId: MatchId;
  readonly senderSeatId: SeatId;
  readonly serverTime: string;
}

export interface UseRoomSocketResult {
  readonly clearError: () => void;
  readonly connectionStatus: RoomConnectionStatus;
  readonly error: RoomSocketError | null;
  readonly pendingCommandTypes: readonly ClientCommand["type"][];
  readonly retry: () => void;
  readonly sendCommand: (command: RoomCommandInput) => RequestId | null;
  readonly sendTransientEvent: (
    matchId: MatchId,
    event: GameTransientCommand["payload"],
  ) => RequestId | null;
  readonly snapshot: ParsedRoomSnapshot | null;
  readonly transientEvent: ParsedGameTransientEvent | null;
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

function reconnectDelayMs(attempt: number): number {
  const ceiling = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 8_000;
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
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
  const [transientEvent, setTransientEvent] = useState<ParsedGameTransientEvent | null>(null);
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
  const sendTransientEventRef = useRef<
    (matchId: MatchId, event: GameTransientCommand["payload"]) => RequestId | null
  >(() => null);
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
    let webSocketEstablishTimer: number | undefined;
    let heartbeatSendTimer: number | undefined;
    let heartbeatResponseTimer: number | undefined;
    let heartbeatIntervalMs = 20_000;
    let heartbeatPongTimeoutMs = 10_000;
    let heartbeatRequestId: RequestId | undefined;
    let lastServerActivityAt = Date.now();
    let offlineObserved = false;
    let socket: WebSocket | null = null;
    let polling: RoomLongPollingTransport | null = null;
    let preferLongPolling = false;
    let currentTransportHadSnapshot = false;
    let currentMatchId: MatchId | undefined;
    let currentGameModule: ReturnType<typeof webGameRegistry.get>;
    let currentTransientEvent: ParsedGameTransientEvent | null = null;
    let pendingTransientEvent: ParsedGameTransientEvent | null = null;
    let queuedTransient: GameTransientCommand | null = null;
    let transientSendTimer: number | undefined;
    let lastTransientSentAt = 0;
    const sentCommands = new Map<RequestId, ClientCommand>();
    const transientRequests = new Set<RequestId>();
    const pending = new Map<RequestId, ClientCommand["type"]>();
    const entryState = entryStateRef.current;

    const clearReconnectExpiry = () => {
      if (reconnectExpiryTimer === undefined) return;
      window.clearTimeout(reconnectExpiryTimer);
      reconnectExpiryTimer = undefined;
    };
    const clearWebSocketEstablishTimer = () => {
      if (webSocketEstablishTimer === undefined) return;
      window.clearTimeout(webSocketEstablishTimer);
      webSocketEstablishTimer = undefined;
    };
    const clearHeartbeat = () => {
      if (heartbeatSendTimer !== undefined) window.clearTimeout(heartbeatSendTimer);
      if (heartbeatResponseTimer !== undefined) window.clearTimeout(heartbeatResponseTimer);
      heartbeatSendTimer = undefined;
      heartbeatResponseTimer = undefined;
      heartbeatRequestId = undefined;
    };
    const ensureReconnectDeadline = () => {
      if (reconnectDeadline === 0) {
        reconnectDeadline = Date.now() + CLIENT_RECOVERY_TIMEOUT_MS;
      }
      clearReconnectExpiry();
      reconnectExpiryTimer = window.setTimeout(
        () => {
          if (disposed || intentionalClose || reconnectDeadline === 0) return;
          reconnectDeadline = 0;
          intentionalClose = true;
          clearHeartbeat();
          clearPending();
          setConnectionStatus("offline");
          setError(socketError("SOCKET_RECONNECT_EXPIRED", "连接恢复超时，请手动重试"));
          if (socket !== null) abandonWebSocket(socket, "连接恢复超时", false);
          if (polling !== null) {
            const expiredPolling = polling;
            polling = null;
            expiredPolling.close();
          }
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
    const publishTransientEvent = (event: ParsedGameTransientEvent | null) => {
      currentTransientEvent = event;
      setTransientEvent(event);
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
    const isWebSocketOpen = () => socket !== null && socket.readyState === WebSocket.OPEN;
    const isTransportOpen = () =>
      !offlineObserved &&
      navigator.onLine !== false &&
      (isWebSocketOpen() || polling?.isOpen === true);
    const sendTransport = (command: ClientCommand): boolean => {
      if (isWebSocketOpen() && socket !== null) {
        socket.send(JSON.stringify(command));
        return true;
      }
      return polling?.send(command) ?? false;
    };
    const scheduleWebSocketHeartbeat = () => {
      if (disposed || intentionalClose || !isWebSocketOpen() || heartbeatRequestId !== undefined) {
        return;
      }
      if (heartbeatSendTimer !== undefined) window.clearTimeout(heartbeatSendTimer);
      const delayMs = Math.max(0, lastServerActivityAt + heartbeatIntervalMs - Date.now());
      heartbeatSendTimer = window.setTimeout(() => {
        heartbeatSendTimer = undefined;
        const activeSocket = socket;
        if (
          disposed ||
          intentionalClose ||
          activeSocket === null ||
          activeSocket.readyState !== WebSocket.OPEN
        ) {
          return;
        }
        const command = clientCommandSchema.parse({
          payload: {},
          protocol: 1,
          requestId: createRequestId(),
          type: "connection.ping",
        });
        heartbeatRequestId = command.requestId;
        try {
          activeSocket.send(JSON.stringify(command));
        } catch {
          abandonWebSocket(activeSocket, "WebSocket 心跳发送失败", true);
          return;
        }
        heartbeatResponseTimer = window.setTimeout(() => {
          if (socket === activeSocket && heartbeatRequestId === command.requestId) {
            abandonWebSocket(activeSocket, "WebSocket 心跳超时", true);
          }
        }, heartbeatPongTimeoutMs);
      }, delayMs);
    };
    const recordServerActivity = () => {
      lastServerActivityAt = Date.now();
      if (heartbeatRequestId === undefined) scheduleWebSocketHeartbeat();
    };
    const acceptHeartbeatPong = (requestId: RequestId) => {
      if (requestId !== heartbeatRequestId) return;
      if (heartbeatResponseTimer !== undefined) {
        window.clearTimeout(heartbeatResponseTimer);
      }
      heartbeatResponseTimer = undefined;
      heartbeatRequestId = undefined;
      scheduleWebSocketHeartbeat();
    };
    const clearQueuedTransient = () => {
      queuedTransient = null;
      if (transientSendTimer !== undefined) window.clearTimeout(transientSendTimer);
      transientSendTimer = undefined;
    };
    const flushTransient = () => {
      transientSendTimer = undefined;
      const command = queuedTransient;
      if (command === null || !isTransportOpen()) return;
      if (
        isWebSocketOpen() &&
        socket !== null &&
        socket.bufferedAmount >= WEB_SOCKET_TRANSIENT_BACKPRESSURE_BYTES
      ) {
        transientSendTimer = window.setTimeout(flushTransient, TRANSIENT_BACKPRESSURE_RETRY_MS);
        return;
      }
      queuedTransient = null;
      lastTransientSentAt = Date.now();
      transientRequests.add(command.requestId);
      if (transientRequests.size > 128) {
        const oldest = transientRequests.values().next().value;
        if (oldest !== undefined) transientRequests.delete(oldest);
      }
      sendTransport(command);
    };
    const sendTransient = (command: GameTransientCommand): boolean => {
      if (!isTransportOpen()) return false;
      queuedTransient = command;
      const intervalMs = isWebSocketOpen() ? 80 : 250;
      const delayMs = Math.max(0, lastTransientSentAt + intervalMs - Date.now());
      if (transientSendTimer === undefined) {
        if (delayMs === 0) flushTransient();
        else transientSendTimer = window.setTimeout(flushTransient, delayMs);
      }
      return true;
    };
    const closeTransport = (code: number, reason: string) => {
      clearHeartbeat();
      clearQueuedTransient();
      socket?.close(code, reason);
      polling?.close();
    };
    const sendParsed = (command: ClientCommand, userCommand: boolean): boolean => {
      if (!isTransportOpen()) return false;
      clearQueuedTransient();
      rememberCommand(command, userCommand);
      return sendTransport(command);
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
      closeTransport(1002, "协议消息无效");
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
      currentGameModule = gameModule;
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
      recordServerActivity();

      switch (message.type) {
        case "connection.ready":
          heartbeatIntervalMs = Math.min(
            60_000,
            Math.max(5_000, message.payload.heartbeatIntervalMs),
          );
          heartbeatPongTimeoutMs = Math.min(30_000, Math.max(2_000, message.payload.pongTimeoutMs));
          scheduleWebSocketHeartbeat();
          sendEntryCommand();
          break;
        case "connection.pong":
          acceptHeartbeatPong(message.causedBy);
          break;
        case "command.ack":
          transientRequests.delete(message.causedBy);
          removePending(message.causedBy);
          sentCommands.delete(message.causedBy);
          break;
        case "command.error": {
          if (message.causedBy === heartbeatRequestId) {
            acceptHeartbeatPong(message.causedBy);
            break;
          }
          if (transientRequests.delete(message.causedBy)) break;
          const failedCommand = sentCommands.get(message.causedBy);
          removePending(message.causedBy);
          sentCommands.delete(message.causedBy);

          if (failedCommand?.type === "room.join") {
            entryState.joinInFlight = false;
            entryState.ambiguousJoin = false;
          }

          if (
            failedCommand?.type === "room.resume" &&
            message.payload.code === "ROOM_PERMISSION_DENIED" &&
            entryState.ambiguousJoin &&
            !entryState.ticketFallbackAttempted &&
            isTransportOpen()
          ) {
            entryState.ambiguousJoin = false;
            sendJoin(true);
            break;
          }
          if (message.payload.resyncRequired && failedCommand !== undefined) {
            // The gateway treats a repeated request ID as a snapshot request without applying it twice.
            clearQueuedTransient();
            sendTransport(failedCommand);
          }
          const commandError = socketError(message.payload.code, message.payload.message, {
            ...(failedCommand === undefined ? {} : { commandType: failedCommand.type }),
            details: message.payload.details,
          });
          setError(commandError);
          if (failedCommand?.type === "room.join" || failedCommand?.type === "room.resume") {
            intentionalClose = true;
            setConnectionStatus("offline");
            closeTransport(1000, "无法进入房间");
          }
          break;
        }
        case "room.snapshot": {
          const nextSnapshot = parseSnapshot(message);
          if (nextSnapshot === null) return;
          currentMatchId = nextSnapshot.matchId;
          if (pendingTransientEvent?.matchId === currentMatchId) {
            publishTransientEvent(pendingTransientEvent);
          } else if (currentTransientEvent?.matchId !== currentMatchId) {
            publishTransientEvent(null);
          }
          pendingTransientEvent = null;
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
          currentTransportHadSnapshot = true;
          clearWebSocketEstablishTimer();
          reconnectAttempt = 0;
          clearReconnectExpiry();
          reconnectDeadline = 0;
          setConnectionStatus("connected");
          setError((current) => (current?.code.startsWith("SOCKET_") === true ? null : current));
          break;
        }
        case "game.transient": {
          if (message.roomId !== roomId) break;
          const belongsToCurrentMatch = message.matchId === currentMatchId;
          const schema = currentGameModule?.shared.transientEventSchema;
          if (schema === undefined) break;
          const event = schema.safeParse(message.payload.event);
          if (!event.success) {
            failProtocol("游戏插件拒绝了服务端返回的临时状态");
            return;
          }
          const nextTransientEvent = {
            event: event.data,
            matchId: message.matchId,
            senderSeatId: message.payload.senderSeatId,
            serverTime: message.serverTime,
          };
          if (belongsToCurrentMatch) publishTransientEvent(nextTransientEvent);
          else pendingTransientEvent = nextTransientEvent;
          break;
        }
        case "room.closed":
          intentionalClose = true;
          clearPending();
          setConnectionStatus("closed");
          pendingTransientEvent = null;
          publishTransientEvent(null);
          setError(socketError("ROOM_CLOSED", message.payload.message));
          closeTransport(1000, "房间已关闭");
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
        setError(socketError("SOCKET_RECONNECT_EXPIRED", "连接恢复超时，请手动重试"));
        return;
      }
      const delay = reconnectDelayMs(reconnectAttempt);
      reconnectAttempt += 1;
      setConnectionStatus("reconnecting");
      if (navigator.onLine === false) return;
      reconnectTimer = window.setTimeout(connect, delay);
    };

    const handleTransportClose = (event: LongPollingTransportClose) => {
      clearHeartbeat();
      clearPending();
      clearQueuedTransient();
      transientRequests.clear();
      pendingTransientEvent = null;
      publishTransientEvent(null);
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
    };

    const connectLongPolling = () => {
      clearWebSocketEstablishTimer();
      clearHeartbeat();
      const connectedPolling = new RoomLongPollingTransport({
        onClose: (event) => {
          if (polling !== connectedPolling) return;
          polling = null;
          currentTransportHadSnapshot = false;
          preferLongPolling = false;
          handleTransportClose(event);
        },
        onMessage: (message) => {
          if (polling === connectedPolling) handleServerMessage(JSON.stringify(message));
        },
      });
      polling = connectedPolling;
      currentTransportHadSnapshot = false;
      void connectedPolling.open();
    };

    function abandonWebSocket(
      connectedSocket: WebSocket,
      reason: string,
      useLongPollingNext: boolean,
    ) {
      if (socket !== connectedSocket) return;
      clearWebSocketEstablishTimer();
      clearHeartbeat();
      if (useLongPollingNext) preferLongPolling = true;
      socket = null;
      currentTransportHadSnapshot = false;
      if (socketRef.current === connectedSocket) socketRef.current = null;
      try {
        connectedSocket.close(4000, reason);
      } catch {
        // A browser policy can reject operations on a disabled WebSocket implementation.
      }
      handleTransportClose({ code: 1006, reason });
    }

    const connectWebSocket = () => {
      let connectedSocket: WebSocket;
      try {
        connectedSocket = new WebSocket(webSocketUrl());
        socket = connectedSocket;
        socketRef.current = connectedSocket;
        currentTransportHadSnapshot = false;
        clearHeartbeat();
        lastServerActivityAt = Date.now();
        clearWebSocketEstablishTimer();
        webSocketEstablishTimer = window.setTimeout(() => {
          if (
            disposed ||
            intentionalClose ||
            socket !== connectedSocket ||
            currentTransportHadSnapshot
          ) {
            return;
          }
          abandonWebSocket(connectedSocket, "WebSocket 建连超时", true);
        }, WEB_SOCKET_ESTABLISH_TIMEOUT_MS);
      } catch {
        preferLongPolling = true;
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
        clearWebSocketEstablishTimer();
        clearHeartbeat();
        if (socketRef.current === connectedSocket) socketRef.current = null;
        if (socket !== connectedSocket) return;
        const failedBeforeSnapshot = !currentTransportHadSnapshot;
        socket = null;
        currentTransportHadSnapshot = false;
        if (failedBeforeSnapshot) preferLongPolling = true;
        handleTransportClose({ code: event.code, reason: event.reason });
      });
      connectedSocket.addEventListener("error", () => {
        // Browsers intentionally hide handshake details; close drives the fallback decision.
      });
    };

    function connect() {
      if (disposed || intentionalClose) return;
      if (navigator.onLine === false) {
        ensureReconnectDeadline();
        setConnectionStatus("reconnecting");
        return;
      }
      if (socket !== null && socket.readyState !== WebSocket.CLOSED) return;
      if (polling !== null) return;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      if (preferLongPolling) connectLongPolling();
      else connectWebSocket();
    }

    sendCommandRef.current = (input) => {
      if (intentionalClose || !isTransportOpen()) return null;
      const requestId = createRequestId();
      const parsed = clientCommandSchema.safeParse({
        ...input,
        protocol: 1,
        requestId,
        roomId,
      });
      if (
        !parsed.success ||
        parsed.data.type === "connection.ping" ||
        parsed.data.type === "room.join" ||
        parsed.data.type === "room.resume" ||
        parsed.data.type === "game.transient"
      ) {
        setError(socketError("VALIDATION_FAILED", "房间命令格式无效"));
        return null;
      }
      if (!sendParsed(parsed.data, true)) return null;
      setError(null);
      return requestId;
    };
    sendTransientEventRef.current = (matchId, event) => {
      if (intentionalClose || !isTransportOpen()) return null;
      const requestId = createRequestId();
      const parsed = clientCommandSchema.safeParse({
        matchId,
        payload: event,
        protocol: 1,
        requestId,
        roomId,
        type: "game.transient",
      });
      if (!parsed.success || parsed.data.type !== "game.transient") return null;
      return sendTransient(parsed.data) ? requestId : null;
    };
    retryRef.current = () => {
      intentionalClose = false;
      reconnectAttempt = 0;
      reconnectDeadline = Date.now() + CLIENT_RECOVERY_TIMEOUT_MS;
      preferLongPolling = false;
      ensureReconnectDeadline();
      setError(null);
      setConnectionStatus("reconnecting");
      if (socket !== null) {
        if (socket.readyState !== WebSocket.CLOSED) {
          abandonWebSocket(socket, "手动重新连接", false);
          return;
        }
        if (socketRef.current === socket) socketRef.current = null;
        socket = null;
      }
      if (polling !== null) {
        const previousPolling = polling;
        polling = null;
        previousPolling.close();
        handleTransportClose({ code: 1006, reason: "手动重新连接" });
        return;
      }
      connect();
    };

    const handleOffline = () => {
      if (disposed || intentionalClose) return;
      offlineObserved = true;
      setConnectionStatus("reconnecting");
    };
    const handleOnline = () => {
      if (!offlineObserved) {
        connect();
        return;
      }
      offlineObserved = false;
      preferLongPolling = false;
      if (socket !== null) {
        abandonWebSocket(socket, "网络已恢复，刷新连接", false);
        return;
      }
      if (polling !== null) {
        const previousPolling = polling;
        polling = null;
        previousPolling.close();
        handleTransportClose({ code: 1006, reason: "网络已恢复，刷新连接" });
        return;
      }
      connect();
    };
    const handleVisibilityChange = () => {
      if (document.hidden) return;
      if (isWebSocketOpen()) scheduleWebSocketHeartbeat();
      else connect();
    };
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    connect();

    return () => {
      disposed = true;
      intentionalClose = true;
      clearQueuedTransient();
      if (entryState.joinInFlight && !entryState.established) {
        entryState.joinInFlight = false;
        entryState.ambiguousJoin = true;
      }
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearReconnectExpiry();
      clearWebSocketEstablishTimer();
      clearHeartbeat();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      clearPending();
      socket?.close(1000, "页面已离开");
      polling?.close();
      if (socketRef.current === socket) socketRef.current = null;
      sendCommandRef.current = () => null;
      sendTransientEventRef.current = () => null;
      retryRef.current = () => undefined;
    };
  }, [initialJoinTicket, roomId]);

  const sendCommand = useCallback(
    (command: RoomCommandInput) => sendCommandRef.current(command),
    [],
  );
  const sendTransientEvent = useCallback(
    (matchId: MatchId, event: GameTransientCommand["payload"]) =>
      sendTransientEventRef.current(matchId, event),
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
    sendTransientEvent,
    snapshot,
    transientEvent,
  };
}
