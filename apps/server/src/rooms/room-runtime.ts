import { randomBytes } from "node:crypto";

import {
  GameRuleError,
  type GameActionActorV1,
  type GameRoomDirectiveV1,
  type GameSystemEventV1,
  type HostedGameTransitionV1,
} from "@tabletop/game-sdk/server";
import type { GameTransientEventV1 } from "@tabletop/game-sdk";
import {
  accountIdSchema,
  matchIdSchema,
  memberIdSchema,
  roomSnapshotPayloadSchema,
  type JsonValue,
  type MemberId,
  type SeatId,
  type SessionId,
} from "@tabletop/protocol";
import { ulid } from "ulid";

import type { GameAutomationExecutor } from "../automation/executor.js";
import { HttpError } from "../http/errors.js";
import { SlidingWindowRateLimiter } from "../lib/rate-limiter.js";
import { secureGameRandom, systemGameClock } from "./game-environment.js";
import { RoomSerialQueue } from "./serial-queue.js";
import type {
  ChatMessageState,
  HumanSeatOccupantState,
  RoomMemberState,
  RoomPublisher,
  RoomSeatState,
  RoomState,
  SeatControllerState,
} from "./types.js";

const RECONNECT_GRACE_MS = 30_000;
const AUTOMATION_RETRY_BASE_MS = 250;
const AUTOMATION_MAX_FAILURES = 5;
const CHAT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export interface RoomRuntimeHooks {
  readonly onDestroyed: (room: RoomState) => void;
  readonly onMemberRemoved: (member: RoomMemberState) => void;
}

export class RoomRuntime {
  readonly queue = new RoomSerialQueue();
  readonly state: RoomState;
  readonly #chatLimiter = new SlidingWindowRateLimiter({ limit: 10, windowMs: 5_000 });
  readonly #deadlineTimers = new Map<string, NodeJS.Timeout>();
  readonly #automationTasks = new Set<string>();
  readonly #automationFailures = new Map<string, { failures: number; state: object }>();
  readonly #automationRetryTimers = new Map<string, NodeJS.Timeout>();
  readonly #automation: GameAutomationExecutor;
  readonly #hooks: RoomRuntimeHooks;
  readonly #publisher: RoomPublisher;
  readonly #reconnectTimers = new Map<MemberId, NodeJS.Timeout>();
  #destroyed = false;

  constructor(
    state: RoomState,
    publisher: RoomPublisher,
    hooks: RoomRuntimeHooks,
    automation: GameAutomationExecutor,
  ) {
    this.state = state;
    this.#automation = automation;
    this.#publisher = publisher;
    this.#hooks = hooks;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  addMember(member: RoomMemberState): Promise<void> {
    return this.queue.run(() => {
      this.#ensureOpen();
      const spectators = [...this.state.members.values()].filter(
        (candidate) => candidate.role === "spectator",
      ).length;
      if (spectators >= 10) {
        throw new HttpError(409, "ROOM_FULL", "房间观战位置已满");
      }
      this.state.members.set(member.memberId, member);
      this.#changed([]);
    });
  }

  attachConnection(memberId: MemberId, connectionId: string, now = Date.now()): Promise<void> {
    return this.queue.run(() => {
      const member = this.#requireMember(memberId);
      const wasReconnecting =
        member.connectionStatus === "reconnecting" &&
        member.reconnectUntil !== undefined &&
        member.reconnectUntil > now;
      member.connectionId = connectionId;
      member.connectionStatus = "connected";
      delete member.reconnectUntil;
      this.#clearReconnectTimer(memberId);

      let events: readonly JsonValue[] = [];
      if (wasReconnecting) {
        events = this.#handleSeatSystemEvent(member, {
          type: "connection.restored",
          seatId: this.#seatForMember(memberId)?.seatId ?? ("" as SeatId),
        });
      }
      this.#transferOfflineHostToConnectedMember();
      this.#changed(events);
    });
  }

  connectionLost(memberId: MemberId, connectionId: string, now = Date.now()): Promise<void> {
    return this.queue.run(() => {
      const member = this.#requireMember(memberId);
      if (member.connectionId !== connectionId) {
        return;
      }

      this.#disconnectOrRemoveMember(member, now);
    });
  }

  departConnection(memberId: MemberId, connectionId: string, now = Date.now()): Promise<void> {
    return this.queue.run(() => {
      const member = this.#requireMember(memberId);
      if (member.connectionId !== connectionId) {
        return;
      }

      this.#disconnectOrRemoveMember(member, now);
    });
  }

  resume(memberId: MemberId, sessionId: SessionId, connectionId: string): Promise<void> {
    return this.queue.run(() => {
      const member = this.#requireMember(memberId);
      if (member.sessionId !== sessionId) {
        throw new HttpError(403, "ROOM_PERMISSION_DENIED", "当前会话不能恢复该房间座位");
      }
      const initialAttachment =
        member.connectionStatus === "offline" && member.connectionId === undefined;
      const restoringConnection =
        member.connectionStatus === "reconnecting" &&
        member.reconnectUntil !== undefined &&
        member.reconnectUntil > Date.now();
      const takingOverConnection =
        member.connectionStatus === "connected" &&
        member.connectionId !== undefined &&
        member.connectionId !== connectionId;
      if (!initialAttachment && !restoringConnection && !takingOverConnection) {
        throw new HttpError(409, "ROOM_INVALID_STATE", "房间重连窗口已经结束");
      }
      const previousConnectionId = member.connectionId;
      member.connectionId = connectionId;
      member.connectionStatus = "connected";
      delete member.reconnectUntil;
      this.#clearReconnectTimer(memberId);
      if (takingOverConnection && previousConnectionId !== undefined) {
        this.#publisher.disconnectConnection(previousConnectionId, 4001, "连接已由同一设备接管");
      }
      const seat = this.#seatForMember(memberId);
      const events =
        restoringConnection && seat
          ? this.#handleSystemEvent({ type: "connection.restored", seatId: seat.seatId })
          : [];
      this.#transferOfflineHostToConnectedMember();
      this.#changed(events);
    });
  }

  leave(memberId: MemberId): Promise<void> {
    return this.queue.run(() => {
      const member = this.#requireMember(memberId);
      const seat = this.#seatForMember(memberId);
      const events = seat
        ? this.#handleSystemEvent({ type: "member.left", seatId: seat.seatId })
        : [];
      this.#removeDepartedMember(member, events);
    });
  }

  rename(memberId: MemberId, name: string, expectedRevision: number): Promise<void> {
    return this.queue.run(() => {
      this.#requireExpectedRevision(expectedRevision);
      this.#requireHost(memberId);
      const normalized = name.trim();
      const length = Array.from(normalized).length;
      if (length < 1 || length > 30) {
        throw new HttpError(400, "VALIDATION_FAILED", "房间名长度必须为 1 到 30 个字符");
      }
      this.state.name = normalized;
      this.#changed([]);
    });
  }

  updateSettings(
    memberId: MemberId,
    settingsInput: unknown,
    expectedRevision: number,
  ): Promise<void> {
    return this.queue.run(() => {
      this.#requireExpectedRevision(expectedRevision);
      this.#requireHost(memberId);
      this.#requireLobbyLike();
      const settings = this.state.game.parseSettings(settingsInput);
      const definitions = this.state.game.getSeatDefinitions(settings);
      const nextIds = new Set(definitions.map(({ seatId }) => seatId));
      if (this.state.seats.some((seat) => seat.occupant !== null && !nextIds.has(seat.seatId))) {
        throw new HttpError(409, "ROOM_INVALID_STATE", "当前座位占用情况不允许修改该设置");
      }
      const existing = new Map(this.state.seats.map((seat) => [seat.seatId, seat]));
      this.state.seats = definitions.map((definition) => {
        const seat = existing.get(definition.seatId);
        if (seat) {
          seat.occupant && seat.occupant.kind === "human" && (seat.occupant.ready = false);
          return { ...seat, displayName: definition.displayName };
        }
        return {
          controller: null,
          displayName: definition.displayName,
          occupant: null,
          reclaimable: false,
          seatId: definition.seatId,
        };
      });
      this.state.settings = settings;
      this.#changed([]);
    });
  }

  claimSeat(memberId: MemberId, seatId: SeatId, expectedRevision: number): Promise<void> {
    return this.queue.run(() => {
      this.#requireExpectedRevision(expectedRevision);
      this.#requireLobbyLike();
      const member = this.#requireMember(memberId);
      if (
        this.state.practice &&
        this.state.game.manifest.capabilities.soloPractice &&
        this.state.seats.some((seat) => seat.occupant !== null)
      ) {
        throw new HttpError(409, "ROOM_INVALID_STATE", "单人练习房只允许一个玩家入座");
      }
      if (
        [...this.state.seats].some(
          (seat) => seat.occupant?.kind === "human" && seat.occupant.accountId === member.accountId,
        )
      ) {
        throw new HttpError(409, "CONNECTION_ROOM_CONFLICT", "该账号已经在此房间占据座位");
      }
      const seat = this.#requireSeat(seatId);
      if (seat.occupant !== null) {
        throw new HttpError(409, "ROOM_INVALID_STATE", "座位已经被占用");
      }
      seat.occupant = {
        accountId: member.accountId,
        displayName: member.displayName,
        kind: "human",
        memberId,
        ready: false,
      };
      seat.controller = { kind: "human" };
      seat.reclaimable = false;
      member.role = "player";
      this.#changed([]);
    });
  }

  reclaimSeat(memberId: MemberId, seatId: SeatId, expectedRevision: number): Promise<void> {
    return this.queue.run(() => {
      this.#requireExpectedRevision(expectedRevision);
      const member = this.#requireMember(memberId);
      const seat = this.#requireSeat(seatId);
      if (
        !seat.reclaimable ||
        seat.occupant?.kind !== "human" ||
        seat.occupant.accountId !== member.accountId
      ) {
        throw new HttpError(403, "ROOM_PERMISSION_DENIED", "当前账号不能取回该座位");
      }
      const events = this.#handleSystemEvent({ type: "seat.reclaim_requested", seatId });
      if (seat.controller?.kind === "human") {
        const previousMemberId = seat.occupant.memberId;
        seat.occupant.memberId = memberId;
        seat.occupant.displayName = member.displayName;
        member.role = "player";
        if (previousMemberId !== memberId) {
          const previousMember = this.state.members.get(previousMemberId);
          if (previousMember) {
            if (previousMember.connectionStatus === "connected") {
              previousMember.role = "spectator";
            } else {
              this.state.members.delete(previousMemberId);
              this.#clearReconnectTimer(previousMemberId);
              this.#hooks.onMemberRemoved(previousMember);
            }
          }
          if (this.state.hostMemberId === previousMemberId) {
            this.state.hostMemberId = memberId;
          }
        }
      }
      this.#changed(events);
    });
  }

  releaseSeat(memberId: MemberId, expectedRevision: number): Promise<void> {
    return this.queue.run(() => {
      this.#requireExpectedRevision(expectedRevision);
      this.#requireLobbyLike();
      const member = this.#requireMember(memberId);
      const seat = this.#seatForMember(memberId);
      if (!seat) {
        throw new HttpError(409, "ROOM_INVALID_STATE", "当前成员没有占据座位");
      }
      seat.occupant = null;
      seat.controller = null;
      seat.reclaimable = false;
      member.role = "spectator";
      this.#changed([]);
    });
  }

  addBot(
    memberId: MemberId,
    seatId: SeatId,
    profileId: string,
    expectedRevision: number,
  ): Promise<void> {
    return this.queue.run(() => {
      this.#requireExpectedRevision(expectedRevision);
      this.#requireHost(memberId);
      this.#requireLobbyLike();
      const profile = this.state.game
        .listBotProfiles()
        .find((item) => item.profileId === profileId);
      if (!profile) {
        throw new HttpError(400, "VALIDATION_FAILED", "AI 配置不存在");
      }
      const seat = this.#requireSeat(seatId);
      if (seat.occupant !== null) {
        throw new HttpError(409, "ROOM_INVALID_STATE", "座位已经被占用");
      }
      seat.occupant = { displayName: profile.displayName, kind: "bot", profileId };
      seat.controller = { kind: "bot", profileId };
      seat.reclaimable = false;
      this.#changed([]);
    });
  }

  removeBot(memberId: MemberId, seatId: SeatId, expectedRevision: number): Promise<void> {
    return this.queue.run(() => {
      this.#requireExpectedRevision(expectedRevision);
      this.#requireHost(memberId);
      this.#requireLobbyLike();
      const seat = this.#requireSeat(seatId);
      if (seat.occupant?.kind !== "bot") {
        throw new HttpError(409, "ROOM_INVALID_STATE", "该座位不是 AI");
      }
      seat.occupant = null;
      seat.controller = null;
      this.#changed([]);
    });
  }

  setReady(memberId: MemberId, ready: boolean, expectedRevision: number): Promise<void> {
    return this.queue.run(() => {
      this.#requireExpectedRevision(expectedRevision);
      this.#requireLobbyLike();
      const seat = this.#seatForMember(memberId);
      if (seat?.occupant?.kind !== "human") {
        throw new HttpError(409, "ROOM_INVALID_STATE", "入座后才能准备");
      }
      seat.occupant.ready = ready;
      this.#changed([]);
    });
  }

  transferHost(
    memberId: MemberId,
    accountIdInput: string,
    expectedRevision: number,
  ): Promise<void> {
    return this.queue.run(() => {
      this.#requireExpectedRevision(expectedRevision);
      this.#requireHost(memberId);
      const accountId = accountIdSchema.parse(accountIdInput);
      const target = [...this.state.members.values()]
        .filter(
          (member) => member.accountId === accountId && member.connectionStatus === "connected",
        )
        .sort((left, right) => left.joinedAt - right.joinedAt)[0];
      if (!target) {
        throw new HttpError(409, "ROOM_INVALID_STATE", "目标用户当前不在房间中");
      }
      this.state.hostMemberId = target.memberId;
      this.#changed([]);
    });
  }

  kickMember(
    memberId: MemberId,
    targetMemberId: MemberId,
    expectedRevision: number,
  ): Promise<void> {
    return this.queue.run(async () => {
      this.#requireExpectedRevision(expectedRevision);
      this.#requireHost(memberId);
      const target = this.#requireMember(targetMemberId);
      if (target.memberId === memberId) {
        throw new HttpError(409, "ROOM_INVALID_STATE", "房主不能踢出自己");
      }
      if (this.state.status === "playing" && target.role === "player") {
        throw new HttpError(409, "ROOM_INVALID_STATE", "对局中不能踢出玩家");
      }
      this.#publisher.disconnectMember(targetMemberId, 4003, "已被房主移出房间");
      await this.#removeMemberWithoutQueue(target);
      this.#changed([]);
    });
  }

  startMatch(memberId: MemberId, expectedRevision: number): Promise<void> {
    return this.queue.run(() => {
      this.#requireExpectedRevision(expectedRevision);
      this.#requireHost(memberId);
      this.#requireLobbyLike();
      const occupied = this.state.seats.filter((seat) => seat.occupant !== null);
      const humans = occupied.filter((seat) => seat.occupant?.kind === "human");
      const minimumPlayers =
        this.state.practice && this.state.game.manifest.capabilities.soloPractice
          ? 1
          : this.state.game.manifest.minPlayers;
      if (
        humans.length === 0 ||
        occupied.length < minimumPlayers ||
        occupied.length > this.state.game.manifest.maxPlayers ||
        humans.some((seat) => seat.occupant?.kind === "human" && !seat.occupant.ready)
      ) {
        throw new HttpError(409, "ROOM_INVALID_STATE", "玩家人数或准备状态不满足开局条件");
      }
      const validation = this.state.game.validateStart(
        this.state.settings,
        this.state.seats.map((seat) => ({
          occupant:
            seat.occupant === null ? "empty" : seat.occupant.kind === "human" ? "human" : "bot",
          ready: seat.occupant?.kind === "human" ? seat.occupant.ready : true,
          seatId: seat.seatId,
        })),
      );
      if (!validation.ok) {
        throw new HttpError(409, "GAME_ILLEGAL_ACTION", "当前房间不能开始游戏", {
          ruleCode: validation.ruleCode,
        });
      }

      const matchId = matchIdSchema.parse(`match-${ulid()}`);
      const state = this.state.game.createMatch(
        {
          clock: systemGameClock,
          matchId,
          random: secureGameRandom,
          seats: occupied.map((seat) => ({
            controller:
              seat.controller?.kind === "bot"
                ? { kind: "bot" as const, profileId: seat.controller.profileId }
                : { kind: "human" as const },
            seatId: seat.seatId,
          })),
          ...(this.state.previousSummary === undefined
            ? {}
            : { previousSummary: this.state.previousSummary }),
        },
        this.state.settings,
      );
      this.state.match = { matchId, state };
      this.state.status = "playing";
      this.#changed([]);
    });
  }

  sendChat(memberId: MemberId, textInput: string): Promise<void> {
    return this.queue.run(() => {
      const member = this.#requireMember(memberId);
      const rate = this.#chatLimiter.consume(member.sessionId);
      if (!rate.allowed) {
        throw new HttpError(429, "RATE_CHAT_LIMIT", "消息发送过于频繁", {
          retryAfterSeconds: Math.ceil(rate.retryAfterMs / 1_000),
        });
      }
      const text = textInput.trim();
      if (
        Array.from(text).length < 1 ||
        Array.from(text).length > 500 ||
        CHAT_CONTROL_CHARACTERS.test(text)
      ) {
        throw new HttpError(400, "VALIDATION_FAILED", "聊天消息格式不符合要求");
      }
      const message: ChatMessageState = {
        memberId,
        messageId: ulid(),
        senderName: member.displayName,
        sentAt: Date.now(),
        text,
      };
      this.state.chat.push(message);
      if (this.state.chat.length > 100) {
        this.state.chat.splice(0, this.state.chat.length - 100);
      }
      this.#changed([]);
    });
  }

  gameAction(
    memberId: MemberId,
    actionInput: unknown,
    matchId: string,
    expectedRevision: number,
    receivedAtMonotonicMs: number,
  ): Promise<boolean> {
    return this.queue.run(() => {
      this.#requireExpectedRevision(expectedRevision);
      const match = this.#requireMatch(matchId);
      const seat = this.#seatForMember(memberId);
      if (!seat || seat.controller?.kind !== "human") {
        throw new HttpError(403, "ROOM_PERMISSION_DENIED", "当前连接没有游戏操作权");
      }
      const transition = this.#callGameAction(
        match.state,
        actionInput,
        {
          kind: "human",
          seatId: seat.seatId,
        },
        receivedAtMonotonicMs,
      );
      if (transition.kind === "noop") {
        return false;
      }
      const events = this.#consumeTransition(transition);
      this.#changed(events);
      return true;
    });
  }

  gameTransient(
    memberId: MemberId,
    eventInput: unknown,
    matchId: string,
  ): Promise<{ readonly event: GameTransientEventV1; readonly senderSeatId: SeatId }> {
    return this.queue.run(() => {
      const match = this.#requireMatch(matchId);
      const seat = this.#seatForMember(memberId);
      if (!seat || seat.controller?.kind !== "human") {
        throw new HttpError(403, "ROOM_PERMISSION_DENIED", "当前连接没有游戏操作权");
      }
      if (!this.state.game.getActiveSeatIds(match.state).includes(seat.seatId)) {
        throw new HttpError(403, "ROOM_PERMISSION_DENIED", "只有当前行动玩家可以同步临时状态");
      }
      const event = this.state.game.parseTransientEvent(eventInput);
      if (event === null) {
        throw new HttpError(400, "VALIDATION_FAILED", "当前游戏不支持临时状态同步");
      }
      return { event, senderSeatId: seat.seatId };
    });
  }

  projectSnapshot(memberId: MemberId, events: readonly JsonValue[] = []) {
    const member = this.#requireMember(memberId);
    const playerSeat = this.#seatForMember(memberId);
    const gameView = this.state.match
      ? this.state.game.projectView(
          {
            clock: systemGameClock,
            matchId: this.state.match.matchId,
            revision: this.state.revision,
          },
          this.state.match.state,
          playerSeat ? { kind: "player", seatId: playerSeat.seatId } : { kind: "spectator" },
        )
      : null;

    return roomSnapshotPayloadSchema.parse({
      chat: this.state.chat.map((message) => ({
        memberId: message.memberId,
        messageId: message.messageId,
        senderName: message.senderName,
        sentAt: new Date(message.sentAt).toISOString(),
        text: message.text,
      })),
      displayEvents: events,
      gameId: this.state.gameId,
      gameView,
      members: [...this.state.members.values()].map((candidate) => ({
        accountId: candidate.accountId,
        connectionStatus: candidate.connectionStatus,
        displayName: candidate.displayName,
        memberId: candidate.memberId,
        reconnectUntil:
          candidate.reconnectUntil === undefined
            ? undefined
            : new Date(candidate.reconnectUntil).toISOString(),
        role: candidate.role,
      })),
      permissions: this.#permissionsFor(member),
      room: {
        hasPassword: this.state.passwordHash !== undefined,
        hostMemberId: this.state.hostMemberId,
        maxSpectators: 10,
        name: this.state.name,
        roomId: this.state.roomId,
        status: this.state.status,
      },
      seats: this.state.seats.map((seat) => ({
        controller: seat.controller,
        displayName: seat.displayName,
        occupant:
          seat.occupant?.kind === "human"
            ? {
                accountId: seat.occupant.accountId,
                displayName: seat.occupant.displayName,
                kind: "human",
                memberId: seat.occupant.memberId,
                ready: seat.occupant.ready,
              }
            : seat.occupant,
        seatId: seat.seatId,
      })),
      settings: this.state.settings,
    });
  }

  destroy(reason: string, message: string): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#clearAllTimers();
    this.#publisher.publishClosed(this.state.roomId, reason, message);
    this.#hooks.onDestroyed(this.state);
  }

  #callGameAction(
    state: object,
    actionInput: unknown,
    actor: GameActionActorV1,
    receivedAtMonotonicMs: number,
  ): HostedGameTransitionV1 {
    const match = this.state.match;
    if (!match) {
      throw new HttpError(409, "ROOM_INVALID_STATE", "对局尚未开始");
    }
    try {
      return this.state.game.handleAction(
        {
          actor,
          clock: systemGameClock,
          matchId: match.matchId,
          random: secureGameRandom,
          receivedAtMonotonicMs,
          revision: this.state.revision,
        },
        state,
        actionInput,
      );
    } catch (error) {
      if (error instanceof GameRuleError) {
        throw new HttpError(400, "GAME_ILLEGAL_ACTION", "该操作不符合当前游戏规则", {
          ruleCode: error.ruleCode,
        });
      }
      throw error;
    }
  }

  #consumeTransition(
    transition: HostedGameTransitionV1,
    directiveReason: "disconnect" | "timeout" = "disconnect",
  ): readonly JsonValue[] {
    if (transition.kind === "noop") {
      return [];
    }
    const match = this.state.match;
    if (!match) {
      throw new Error("游戏转换发生时没有活动对局");
    }
    match.state = transition.state;
    for (const directive of transition.roomDirectives ?? []) {
      this.#applyDirective(directive, directiveReason);
    }
    if (transition.outcome) {
      this.state.status = "post_match";
      this.state.previousSummary = {
        matchId: match.matchId,
        ...(transition.outcome.publicSummary === undefined
          ? {}
          : { publicSummary: transition.outcome.publicSummary }),
      };
      for (const seat of this.state.seats) {
        if (seat.occupant?.kind === "human") {
          seat.occupant.ready = false;
          if (!this.state.members.has(seat.occupant.memberId)) {
            seat.occupant = null;
            seat.controller = null;
            seat.reclaimable = false;
          }
        }
      }
    }
    return transition.events;
  }

  #applyDirective(directive: GameRoomDirectiveV1, reason: "disconnect" | "timeout"): void {
    const seat = this.#requireSeat(directive.seatId);
    switch (directive.type) {
      case "seat.useFallbackController":
        seat.controller = { kind: "fallback", reason };
        break;
      case "seat.returnHumanControl":
        seat.controller = { kind: "human" };
        break;
      case "seat.release": {
        const member =
          seat.occupant?.kind === "human"
            ? this.state.members.get(seat.occupant.memberId)
            : undefined;
        if (member) {
          member.role = "spectator";
        }
        seat.occupant = null;
        seat.controller = null;
        seat.reclaimable = false;
        break;
      }
      case "seat.setReclaimable":
        seat.reclaimable = directive.reclaimable;
        break;
    }
  }

  #handleSeatSystemEvent(member: RoomMemberState, event: GameSystemEventV1): readonly JsonValue[] {
    const seat = this.#seatForMember(member.memberId);
    return seat ? this.#handleSystemEvent({ ...event, seatId: seat.seatId }) : [];
  }

  #handleSystemEvent(event: GameSystemEventV1): readonly JsonValue[] {
    const match = this.state.match;
    if (!match || this.state.status !== "playing") {
      return [];
    }
    const transition = this.state.game.handleSystemEvent(
      {
        clock: systemGameClock,
        matchId: match.matchId,
        random: secureGameRandom,
        revision: this.state.revision,
      },
      match.state,
      event,
    );
    return this.#consumeTransition(transition, "disconnect");
  }

  #changed(events: readonly JsonValue[]): void {
    if (this.#destroyed) {
      return;
    }
    this.state.revision += 1;
    this.#rescheduleDeadlines();
    this.#publisher.publishSnapshot(this, events);
    this.#scheduleAutomation();
  }

  #rescheduleDeadlines(): void {
    for (const timer of this.#deadlineTimers.values()) {
      clearTimeout(timer);
    }
    this.#deadlineTimers.clear();
    const match = this.state.match;
    if (!match || this.state.status !== "playing") {
      return;
    }
    for (const deadline of this.state.game.getDeadlines(match.state)) {
      const revision = this.state.revision;
      const timer = setTimeout(
        () => {
          void this.queue.run(() => {
            if (
              this.state.match?.matchId !== match.matchId ||
              this.state.revision !== revision ||
              this.state.status !== "playing"
            ) {
              return;
            }
            const transition = this.state.game.handleDeadline(
              {
                clock: systemGameClock,
                firedAtMonotonicMs: systemGameClock.monotonicMs(),
                matchId: match.matchId,
                random: secureGameRandom,
                revision,
              },
              match.state,
              deadline,
            );
            if (transition.kind === "applied") {
              this.#changed(this.#consumeTransition(transition, "timeout"));
            }
          });
        },
        Math.max(0, deadline.dueAtMonotonicMs - systemGameClock.monotonicMs()),
      );
      timer.unref();
      this.#deadlineTimers.set(deadline.deadlineId, timer);
    }
  }

  #scheduleAutomation(): void {
    if (this.#destroyed) return;
    const match = this.state.match;
    if (!match || this.state.status !== "playing") {
      return;
    }
    for (const seatId of this.state.game.getActiveSeatIds(match.state)) {
      const seat = this.state.seats.find((candidate) => candidate.seatId === seatId);
      if (!seat || seat.controller?.kind === "human" || seat.controller === null) {
        continue;
      }
      const revision = this.state.revision;
      const matchState = match.state;
      const key = `${match.matchId}:${seatId}`;
      if (this.#automationTasks.has(key) || this.#automationRetryTimers.has(key)) {
        continue;
      }
      this.#automationTasks.add(key);
      const controller = seat.controller;
      const inputContext = {
        clock: systemGameClock,
        matchId: match.matchId,
        revision,
      };
      const decisionSeed = randomBytes(16).toString("hex");

      const task =
        controller.kind === "bot"
          ? this.#chooseBotAction(
              matchState,
              seatId,
              controller.profileId,
              inputContext,
              decisionSeed,
            )
          : this.#chooseFallbackAction(
              matchState,
              seatId,
              controller.reason,
              inputContext,
              decisionSeed,
            );
      let shouldReschedule = false;
      let taskFailed = false;
      void task
        .then((action) =>
          this.queue.run(() => {
            if (this.#destroyed) return;
            if (
              this.state.match?.matchId !== match.matchId ||
              this.state.match.state !== matchState ||
              this.state.status !== "playing" ||
              !this.state.game.getActiveSeatIds(matchState).includes(seatId)
            ) {
              shouldReschedule = true;
              return;
            }
            const currentSeat = this.#requireSeat(seatId);
            if (currentSeat.controller !== controller) {
              shouldReschedule = true;
              return;
            }
            const actor: GameActionActorV1 =
              controller.kind === "bot"
                ? { kind: "bot", profileId: controller.profileId, seatId }
                : { kind: "fallback", reason: controller.reason, seatId };
            const transition = this.#callGameAction(
              matchState,
              action,
              actor,
              systemGameClock.monotonicMs(),
            );
            if (transition.kind === "applied") {
              this.#changed(this.#consumeTransition(transition));
              shouldReschedule = true;
            }
          }),
        )
        .catch(() => {
          taskFailed = true;
        })
        .finally(() => {
          this.#automationTasks.delete(key);
          if (this.#destroyed) return;
          if (taskFailed) {
            this.#scheduleAutomationRetry(key, match.matchId, matchState, seatId, controller);
            return;
          }
          this.#automationFailures.delete(key);
          if (shouldReschedule) this.#scheduleAutomation();
        });
    }
  }

  async #chooseBotAction(
    matchState: object,
    seatId: SeatId,
    profileId: string,
    context: Parameters<RoomState["game"]["createBotInput"]>[0],
    decisionSeed: string,
  ) {
    const profile = this.state.game.listBotProfiles().find((item) => item.profileId === profileId);
    if (!profile) throw new Error("AI 配置不存在");
    const input = this.state.game.createBotInput(context, matchState, seatId);
    return this.#automation.chooseBotAction(
      this.state.gameId,
      this.state.game,
      {
        decisionSeed,
        hardDeadlineMonotonicMs: systemGameClock.monotonicMs() + profile.timeBudgetMs,
        input,
        profileId,
        revision: context.revision,
        seatId,
      },
      profile.timeBudgetMs,
    );
  }

  async #chooseFallbackAction(
    matchState: object,
    seatId: SeatId,
    reason: "disconnect" | "timeout",
    context: Parameters<RoomState["game"]["createFallbackInput"]>[0],
    decisionSeed: string,
  ) {
    const input = this.state.game.createFallbackInput(context, matchState, seatId);
    return this.#automation.chooseFallbackAction(
      this.state.gameId,
      this.state.game,
      {
        decisionSeed,
        hardDeadlineMonotonicMs: systemGameClock.monotonicMs() + 250,
        input,
        revision: context.revision,
        seatId,
      },
      reason,
      250,
    );
  }

  #scheduleAutomationRetry(
    key: string,
    matchId: string,
    matchState: object,
    seatId: SeatId,
    controller: SeatControllerState,
  ): void {
    const previous = this.#automationFailures.get(key);
    const failures = previous?.state === matchState ? previous.failures + 1 : 1;
    if (failures >= AUTOMATION_MAX_FAILURES) {
      this.#automationFailures.delete(key);
      this.destroy("internal_error", "AI 连续执行失败，房间已关闭");
      return;
    }
    this.#automationFailures.set(key, { failures, state: matchState });
    const delay = Math.min(AUTOMATION_RETRY_BASE_MS * 2 ** (failures - 1), 2_000);
    const timer = setTimeout(() => {
      this.#automationRetryTimers.delete(key);
      if (this.#destroyed) return;
      const match = this.state.match;
      const seat = this.state.seats.find((candidate) => candidate.seatId === seatId);
      if (
        match?.matchId !== matchId ||
        match.state !== matchState ||
        this.state.status !== "playing" ||
        seat?.controller !== controller ||
        !this.state.game.getActiveSeatIds(matchState).includes(seatId)
      ) {
        this.#automationFailures.delete(key);
      }
      this.#scheduleAutomation();
    }, delay);
    timer.unref();
    this.#automationRetryTimers.set(key, timer);
  }

  #scheduleReconnectExpiry(member: RoomMemberState): void {
    this.#clearReconnectTimer(member.memberId);
    const reconnectUntil = member.reconnectUntil;
    if (reconnectUntil === undefined) return;
    const timer = setTimeout(
      () => {
        void this.queue.run(() => {
          if (
            member.connectionStatus !== "reconnecting" ||
            member.reconnectUntil !== reconnectUntil
          ) {
            return;
          }
          member.connectionStatus = "offline";
          delete member.reconnectUntil;
          const seatBeforeEvent = this.#seatForMember(member.memberId);
          const events = seatBeforeEvent
            ? this.#handleSystemEvent({
                type: "connection.grace_expired",
                seatId: seatBeforeEvent.seatId,
              })
            : [];
          this.#removeDepartedMember(member, events);
        });
      },
      Math.max(0, reconnectUntil - Date.now()),
    );
    timer.unref();
    this.#reconnectTimers.set(member.memberId, timer);
  }

  #disconnectOrRemoveMember(member: RoomMemberState, now: number): void {
    delete member.connectionId;
    if (this.state.status !== "playing") {
      member.connectionStatus = "offline";
      delete member.reconnectUntil;
      this.#removeDepartedMember(member, []);
      return;
    }

    member.connectionStatus = "reconnecting";
    member.reconnectUntil = now + RECONNECT_GRACE_MS;
    const seat = this.#seatForMember(member.memberId);
    const events = seat
      ? this.#handleSystemEvent({
          type: "connection.lost",
          seatId: seat.seatId,
          graceDeadlineMs: member.reconnectUntil,
        })
      : [];
    this.#scheduleReconnectExpiry(member);
    this.#changed(events);
  }

  #removeDepartedMember(member: RoomMemberState, events: readonly JsonValue[]): void {
    const seat = this.#seatForMember(member.memberId);
    this.#clearReconnectTimer(member.memberId);
    this.state.members.delete(member.memberId);
    this.#hooks.onMemberRemoved(member);

    if (seat) {
      seat.reclaimable = false;
      if (seat.controller?.kind === "human" || this.state.status !== "playing") {
        seat.occupant = null;
        seat.controller = null;
      }
    }

    if (this.#destroyEmptySoloPracticeRoom()) {
      return;
    }
    if (!this.#hasActiveMember()) {
      this.destroy("last_human_left", "最后一名真人已离开房间");
      return;
    }
    if (this.state.hostMemberId === member.memberId) {
      this.#transferHostToEarliestMember();
    }
    this.#changed(events);
  }

  #permissionsFor(member: RoomMemberState) {
    const isHost = this.state.hostMemberId === member.memberId;
    const ownSeat = this.#seatForMember(member.memberId);
    const lobbyLike = this.state.status !== "playing";
    return {
      botAddableSeatIds:
        isHost && lobbyLike && this.state.game.manifest.capabilities.bots
          ? this.state.seats.filter((seat) => seat.occupant === null).map((seat) => seat.seatId)
          : [],
      botRemovableSeatIds:
        isHost && lobbyLike
          ? this.state.seats
              .filter((seat) => seat.occupant?.kind === "bot")
              .map((seat) => seat.seatId)
          : [],
      canReleaseSeat: Boolean(ownSeat && lobbyLike),
      canRenameRoom: isHost,
      canSendChat: true,
      canSetReady: Boolean(ownSeat && lobbyLike),
      canStartMatch: isHost && lobbyLike,
      canSubmitGameAction: Boolean(ownSeat?.controller?.kind === "human"),
      canTransferHost: isHost,
      canUpdateSettings: isHost && lobbyLike,
      claimableSeatIds:
        !ownSeat &&
        lobbyLike &&
        !(
          this.state.practice &&
          this.state.game.manifest.capabilities.soloPractice &&
          this.state.seats.some((seat) => seat.occupant !== null)
        )
          ? this.state.seats.filter((seat) => seat.occupant === null).map((seat) => seat.seatId)
          : [],
      kickableMemberIds: isHost
        ? [...this.state.members.values()]
            .filter(
              (candidate) =>
                candidate.memberId !== member.memberId &&
                (this.state.status !== "playing" || candidate.role === "spectator"),
            )
            .map((candidate) => candidate.memberId)
        : [],
      reclaimableSeatIds: this.state.seats
        .filter(
          (seat) =>
            seat.reclaimable &&
            seat.occupant?.kind === "human" &&
            seat.occupant.accountId === member.accountId,
        )
        .map((seat) => seat.seatId),
    };
  }

  async #removeMemberWithoutQueue(member: RoomMemberState): Promise<void> {
    const seat = this.#seatForMember(member.memberId);
    if (seat) {
      seat.occupant = null;
      seat.controller = null;
      seat.reclaimable = false;
    }
    this.state.members.delete(member.memberId);
    this.#clearReconnectTimer(member.memberId);
    this.#hooks.onMemberRemoved(member);
    if (this.state.hostMemberId === member.memberId && this.state.members.size > 0) {
      this.#transferHostToEarliestMember();
    }
  }

  #transferHostToEarliestMember(): void {
    const nextHost = [...this.state.members.values()].sort(
      (left, right) => left.joinedAt - right.joinedAt,
    )[0];
    if (!nextHost) {
      throw new Error("房间没有可转移的房主");
    }
    this.state.hostMemberId = nextHost.memberId;
  }

  #transferOfflineHostToConnectedMember(): void {
    const host = this.state.members.get(this.state.hostMemberId);
    if (host?.connectionStatus !== "offline") return;
    const nextHost = [...this.state.members.values()]
      .filter((member) => member.connectionStatus === "connected")
      .sort((left, right) => left.joinedAt - right.joinedAt)[0];
    if (nextHost) this.state.hostMemberId = nextHost.memberId;
  }

  #requireExpectedRevision(expectedRevision: number): void {
    if (expectedRevision !== this.state.revision) {
      throw new HttpError(409, "REVISION_STALE", "房间状态已经更新，请重试", {
        currentRevision: this.state.revision,
      });
    }
  }

  #requireLobbyLike(): void {
    if (this.state.status === "playing") {
      throw new HttpError(409, "ROOM_INVALID_STATE", "对局中不能执行该操作");
    }
  }

  #requireMatch(matchIdInput: string) {
    const match = this.state.match;
    if (!match || match.matchId !== matchIdInput || this.state.status !== "playing") {
      throw new HttpError(409, "ROOM_INVALID_STATE", "对局不存在或已经结束");
    }
    return match;
  }

  #requireHost(memberId: MemberId): RoomMemberState {
    if (this.state.hostMemberId !== memberId) {
      throw new HttpError(403, "ROOM_PERMISSION_DENIED", "只有房主可以执行该操作");
    }
    return this.#requireMember(memberId);
  }

  #requireMember(memberId: MemberId): RoomMemberState {
    this.#ensureOpen();
    const member = this.state.members.get(memberId);
    if (!member) {
      throw new HttpError(404, "ROOM_NOT_FOUND", "房间成员不存在");
    }
    return member;
  }

  #requireSeat(seatId: SeatId): RoomSeatState {
    const seat = this.state.seats.find((candidate) => candidate.seatId === seatId);
    if (!seat) {
      throw new HttpError(400, "VALIDATION_FAILED", "座位不存在");
    }
    return seat;
  }

  #seatForMember(memberId: MemberId): RoomSeatState | undefined {
    return this.state.seats.find(
      (seat) => seat.occupant?.kind === "human" && seat.occupant.memberId === memberId,
    );
  }

  #hasActiveMember(): boolean {
    return [...this.state.members.values()].some(
      (member) =>
        member.connectionStatus === "connected" || member.connectionStatus === "reconnecting",
    );
  }

  #destroyEmptySoloPracticeRoom(): boolean {
    if (
      !this.state.practice ||
      !this.state.game.manifest.capabilities.soloPractice ||
      this.state.seats.some((seat) => seat.occupant !== null)
    ) {
      return false;
    }
    this.destroy("last_human_left", "最后一名练习玩家已离开房间");
    return true;
  }

  #ensureOpen(): void {
    if (this.#destroyed) {
      throw new HttpError(404, "ROOM_NOT_FOUND", "房间不存在");
    }
  }

  #clearReconnectTimer(memberId: MemberId): void {
    const timer = this.#reconnectTimers.get(memberId);
    if (timer) {
      clearTimeout(timer);
      this.#reconnectTimers.delete(memberId);
    }
  }

  #clearAllTimers(): void {
    for (const timer of this.#automationRetryTimers.values()) clearTimeout(timer);
    for (const timer of this.#deadlineTimers.values()) clearTimeout(timer);
    for (const timer of this.#reconnectTimers.values()) clearTimeout(timer);
    this.#automationFailures.clear();
    this.#automationRetryTimers.clear();
    this.#deadlineTimers.clear();
    this.#reconnectTimers.clear();
  }
}
