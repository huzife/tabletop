import { randomBytes } from "node:crypto";

import type { Account, Session, TabletopRepositories } from "@tabletop/database";
import type { GameServerRegistryV1 } from "@tabletop/game-sdk/server";
import {
  accountIdSchema,
  gameIdSchema,
  memberIdSchema,
  roomIdSchema,
  sessionIdSchema,
  type JsonValue,
  type MemberId,
  type RoomId,
  type SessionId,
} from "@tabletop/protocol";
import { ulid } from "ulid";

import {
  InProcessAutomationExecutor,
  type GameAutomationExecutor,
} from "../automation/executor.js";
import { HttpError } from "../http/errors.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import { RoomPasswordCapacityError, RoomPasswordService } from "./password.js";
import { RoomRuntime } from "./room-runtime.js";
import type { RoomMemberState, RoomPublisher, RoomSeatState, RoomState } from "./types.js";

const JOIN_TICKET_TTL_MS = 30_000;

interface JoinTicketState {
  readonly expiresAt: number;
  readonly memberId?: MemberId;
  readonly roomId: RoomId;
  readonly sessionId: SessionId;
  readonly source: "create" | "invite" | "list";
}

export interface CreateRoomInput {
  readonly account: Account;
  readonly botProfileId?: string;
  readonly session: Session;
  readonly gameId: string;
  readonly isCancelled?: () => boolean;
  readonly name: string;
  readonly password?: string;
  readonly practice: boolean;
  readonly settings: unknown;
}

const noOpPublisher: RoomPublisher = {
  disconnectConnection: () => undefined,
  disconnectMember: () => undefined,
  publishClosed: () => undefined,
  publishSnapshot: () => undefined,
};

export class RoomRegistry {
  readonly #games: GameServerRegistryV1;
  readonly #automation: GameAutomationExecutor;
  readonly #inviteRooms = new Map<string, RoomId>();
  readonly #joinTicketTimers = new Map<string, NodeJS.Timeout>();
  readonly #joinTickets = new Map<string, JoinTicketState>();
  readonly #membersBySession = new Map<SessionId, Map<RoomId, MemberId>>();
  readonly #passwords: RoomPasswordService;
  readonly #repositories: TabletopRepositories;
  readonly #rooms = new Map<RoomId, RoomRuntime>();
  readonly #sessionMutex = new KeyedMutex<SessionId>();
  #publisher: RoomPublisher = noOpPublisher;

  constructor(options: {
    readonly automation?: GameAutomationExecutor;
    readonly games: GameServerRegistryV1;
    readonly passwords?: RoomPasswordService;
    readonly repositories: TabletopRepositories;
  }) {
    this.#automation = options.automation ?? new InProcessAutomationExecutor();
    this.#games = options.games;
    this.#passwords = options.passwords ?? new RoomPasswordService();
    this.#repositories = options.repositories;
    this.#repositories.services.syncRegisteredGames(
      this.#games.list().map((game) => game.manifest.gameId),
    );
  }

  setPublisher(publisher: RoomPublisher): void {
    this.#publisher = publisher;
  }

  listGames() {
    const settings = new Map(
      this.#repositories.services
        .listRegisteredGames(this.#games.list().map((game) => game.manifest.gameId))
        .map((setting) => [setting.gameId, setting]),
    );
    return this.#games.list().map((game) => ({
      ...game.manifest,
      botProfiles: game.listBotProfiles(),
      enabled: settings.get(game.manifest.gameId)?.enabled ?? false,
    }));
  }

  getSiteStatus() {
    return this.#repositories.services.initializeSite();
  }

  listPublicRooms(sessionIdInput?: string) {
    const sessionId =
      sessionIdInput === undefined ? undefined : sessionIdSchema.parse(sessionIdInput);
    return [...this.#rooms.values()].flatMap((room) => {
      if (room.destroyed) return [];
      const binding =
        sessionId === undefined ? undefined : this.bindingForSession(sessionId, room.state.roomId);
      if (room.state.practice && binding === undefined) return [];
      const host = room.state.members.get(room.state.hostMemberId);
      const resumeAvailable = binding !== undefined;
      const normallyJoinable =
        room.state.status !== "playing" || room.state.game.manifest.capabilities.midgameJoin;
      return [
        {
          gameId: room.state.gameId,
          hasPassword: room.state.passwordHash !== undefined,
          hostName: host?.displayName ?? "房主",
          joinable: resumeAvailable || normallyJoinable,
          maxPlayers: room.state.seats.length,
          maxSpectators: 10,
          name: room.state.name,
          occupiedSeats: room.state.seats.filter((seat) => seat.occupant !== null).length,
          roomId: room.state.roomId,
          spectatorCount: [...room.state.members.values()].filter(
            (member) => member.role === "spectator",
          ).length,
          resumeAvailable,
          status: room.state.status,
        },
      ];
    });
  }

  async createRoom(input: CreateRoomInput) {
    this.#ensureSiteEnabled();
    const gameId = gameIdSchema.parse(input.gameId);
    this.#ensureGameEnabled(gameId);
    const sessionId = sessionIdSchema.parse(input.session.id);
    this.#ensureSessionActive(input.session, input.account.id);
    const game = this.#games.require(gameId);
    const settings = game.parseSettings(input.settings);
    const name = normalizeRoomName(input.name);
    let passwordHash: string | undefined;
    try {
      passwordHash = input.password ? await this.#passwords.hash(input.password) : undefined;
    } catch (error) {
      this.#throwPasswordCapacityError(error);
    }
    if (input.isCancelled?.()) {
      throw new HttpError(499, "INTERNAL_ROOM_ABORTED", "建房请求已经取消");
    }

    return this.#sessionMutex.run(sessionId, async () => {
      this.#ensureSiteEnabled();
      this.#ensureGameEnabled(gameId);
      this.#ensureSessionActive(input.session, input.account.id);
      if (input.isCancelled?.()) {
        throw new HttpError(499, "INTERNAL_ROOM_ABORTED", "建房请求已经取消");
      }
      const roomId = roomIdSchema.parse(`room-${ulid()}`);
      const memberId = memberIdSchema.parse(`member-${ulid()}`);
      const accountId = accountIdSchema.parse(input.account.id);
      const inviteToken = randomBytes(24).toString("base64url");
      const member: RoomMemberState = {
        accountId,
        connectionStatus: "offline",
        displayName: input.account.username,
        joinedAt: Date.now(),
        memberId,
        role: input.practice ? "player" : "spectator",
        sessionId,
      };
      const definitions = game.getSeatDefinitions(settings);
      const seats: RoomSeatState[] = definitions.map((definition) => ({
        controller: null,
        displayName: definition.displayName,
        occupant: null,
        reclaimable: false,
        seatId: definition.seatId,
      }));

      if (input.practice) {
        const humanSeat = seats[0];
        const { bots, soloPractice } = game.manifest.capabilities;
        if (!humanSeat || (!bots && !soloPractice)) {
          throw new HttpError(400, "VALIDATION_FAILED", "该游戏或 AI 难度不支持单人练习");
        }
        humanSeat.occupant = {
          accountId,
          displayName: input.account.username,
          kind: "human",
          memberId,
          ready: false,
        };
        humanSeat.controller = { kind: "human" };

        if (bots) {
          const botProfiles = game.listBotProfiles();
          const botProfile = input.botProfileId
            ? botProfiles.find(({ profileId }) => profileId === input.botProfileId)
            : botProfiles[0];
          if (!botProfile) {
            throw new HttpError(400, "VALIDATION_FAILED", "该游戏或 AI 难度不支持单人练习");
          }
          for (const seat of seats.slice(1)) {
            seat.occupant = {
              displayName: botProfile.displayName,
              kind: "bot",
              profileId: botProfile.profileId,
            };
            seat.controller = { kind: "bot", profileId: botProfile.profileId };
          }
        } else if (input.botProfileId !== undefined) {
          throw new HttpError(400, "VALIDATION_FAILED", "该游戏不提供 AI 难度");
        }
        const validation = game.validateStart(
          settings,
          seats.map((seat) => ({
            occupant:
              seat.occupant === null ? "empty" : seat.occupant.kind === "human" ? "human" : "bot",
            ready: seat.occupant !== null,
            seatId: seat.seatId,
          })),
        );
        if (!validation.ok) {
          throw new HttpError(409, "GAME_ILLEGAL_ACTION", "当前设置不支持单人练习", {
            ruleCode: validation.ruleCode,
            ...(validation.publicDetails === undefined
              ? {}
              : { publicDetails: validation.publicDetails }),
          });
        }
      }

      const state: RoomState = {
        chat: [],
        createdAt: Date.now(),
        creatorAccountId: accountId,
        game,
        gameId,
        hostMemberId: memberId,
        inviteToken,
        members: new Map([[memberId, member]]),
        name,
        practice: input.practice,
        revision: 0,
        seats,
        settings,
        status: "lobby",
        roomId,
        ...(passwordHash === undefined ? {} : { passwordHash }),
      };
      const runtime = new RoomRuntime(
        state,
        this.#publisherProxy(),
        {
          onDestroyed: (destroyed) => this.#removeDestroyedRoom(destroyed),
          onMemberRemoved: (removed) => this.#releaseMemberBinding(state.roomId, removed),
        },
        this.#automation,
      );
      this.#rooms.set(roomId, runtime);
      this.#inviteRooms.set(inviteToken, roomId);
      this.#setMemberBinding(sessionId, roomId, memberId);
      const ticket = this.#createJoinTicket({
        memberId,
        roomId,
        sessionId,
        source: "create",
      });
      return { room: runtime, ticket };
    });
  }

  async issueListJoinTicket(options: {
    readonly roomId: string;
    readonly session: Session;
    readonly password?: string;
  }) {
    const room = this.require(options.roomId);
    this.#ensureSiteEnabled();
    this.#ensureGameEnabled(gameIdSchema.parse(room.state.gameId));
    const sessionId = sessionIdSchema.parse(options.session.id);
    this.#ensureSessionActive(options.session);
    this.#ensureRoomAvailableForSession(sessionId, room.state.roomId);
    if (room.state.passwordHash) {
      let verified = false;
      try {
        verified = Boolean(
          options.password &&
          (await this.#passwords.verify(room.state.passwordHash, options.password)),
        );
      } catch (error) {
        this.#throwPasswordCapacityError(error);
      }
      if (!verified) {
        throw new HttpError(403, "ROOM_PASSWORD_INVALID", "房间密码不正确");
      }
    }
    this.#ensureSiteEnabled();
    const currentRoom = this.require(room.state.roomId);
    this.#ensureGameEnabled(gameIdSchema.parse(currentRoom.state.gameId));
    this.#ensureSessionActive(options.session);
    this.#ensureRoomAvailableForSession(sessionId, currentRoom.state.roomId);
    return this.#createJoinTicket({
      roomId: currentRoom.state.roomId,
      sessionId,
      source: "list",
    });
  }

  issueInviteJoinTicket(options: { inviteToken: string; session: Session }) {
    const roomId = this.#inviteRooms.get(options.inviteToken);
    if (!roomId) {
      throw new HttpError(404, "ROOM_NOT_FOUND", "邀请链接无效或房间已经关闭");
    }
    const room = this.require(roomId);
    this.#ensureSiteEnabled();
    this.#ensureGameEnabled(gameIdSchema.parse(room.state.gameId));
    const sessionId = sessionIdSchema.parse(options.session.id);
    this.#ensureSessionActive(options.session);
    this.#ensureRoomAvailableForSession(sessionId, roomId);
    return this.#createJoinTicket({ roomId, sessionId, source: "invite" });
  }

  async consumeJoinTicket(
    token: string,
    account: Account,
    session: Session,
  ): Promise<{ member: RoomMemberState; room: RoomRuntime }> {
    const ticket = this.#joinTickets.get(token);
    const sessionId = sessionIdSchema.parse(session.id);
    if (!ticket || ticket.sessionId !== sessionId) {
      throw new HttpError(403, "ROOM_PERMISSION_DENIED", "加入凭据无效或已经过期");
    }
    if (ticket.expiresAt <= Date.now()) {
      this.#expireJoinTicket(token, ticket);
      throw new HttpError(403, "ROOM_PERMISSION_DENIED", "加入凭据无效或已经过期");
    }
    this.#deleteJoinTicket(token);

    return this.#sessionMutex.run(sessionId, async () => {
      this.#ensureSiteEnabled();
      this.#ensureSessionActive(session, account.id);
      const room = this.require(ticket.roomId);
      this.#ensureGameEnabled(gameIdSchema.parse(room.state.gameId));
      const existingBinding = this.bindingForSession(sessionId, ticket.roomId);
      if (
        existingBinding &&
        (ticket.memberId === undefined || existingBinding.memberId !== ticket.memberId)
      ) {
        throw new HttpError(409, "CONNECTION_ROOM_CONFLICT", "当前设备已经加入该房间");
      }
      let member = ticket.memberId ? room.state.members.get(ticket.memberId) : undefined;
      member ??= [...room.state.members.values()].find(
        (candidate) =>
          candidate.sessionId === sessionId && candidate.connectionStatus === "offline",
      );
      if (!member) {
        const memberId = memberIdSchema.parse(`member-${ulid()}`);
        member = {
          accountId: accountIdSchema.parse(account.id),
          connectionStatus: "offline",
          displayName: account.username,
          joinedAt: Date.now(),
          memberId,
          role: "spectator",
          sessionId,
        };
        await room.addMember(member);
      }
      this.#setMemberBinding(sessionId, room.state.roomId, member.memberId);
      return { member, room };
    });
  }

  bindingForSession(sessionIdInput: string, roomIdInput?: string | RoomId) {
    const sessionId = sessionIdSchema.parse(sessionIdInput);
    const bindings = this.#membersBySession.get(sessionId);
    if (!bindings) return undefined;
    if (roomIdInput !== undefined) {
      const roomId = roomIdSchema.parse(roomIdInput);
      const memberId = bindings.get(roomId);
      if (memberId === undefined) return undefined;
      return this.#validateBinding(sessionId, roomId, memberId) ? { memberId, roomId } : undefined;
    }
    for (const [roomId, memberId] of [...bindings]) {
      if (this.#validateBinding(sessionId, roomId, memberId)) {
        return { memberId, roomId };
      }
    }
    return undefined;
  }

  confirmMemberAttached(memberId: MemberId): void {
    for (const [token, ticket] of this.#joinTickets) {
      if (ticket.source === "create" && ticket.memberId === memberId) {
        this.#deleteJoinTicket(token);
      }
    }
  }

  require(roomIdInput: string | RoomId): RoomRuntime {
    const roomId = roomIdSchema.parse(roomIdInput);
    const room = this.#rooms.get(roomId);
    if (!room || room.destroyed) {
      throw new HttpError(404, "ROOM_NOT_FOUND", "房间不存在");
    }
    return room;
  }

  hasAccountMembership(accountId: string): boolean {
    return [...this.#rooms.values()].some((room) =>
      [...room.state.members.values()].some((member) => member.accountId === accountId),
    );
  }

  isAccountOnline(accountId: string): boolean {
    return [...this.#rooms.values()].some((room) =>
      [...room.state.members.values()].some(
        (member) => member.accountId === accountId && member.connectionStatus === "connected",
      ),
    );
  }

  async removeAccount(accountId: string): Promise<void> {
    const removals: Promise<void>[] = [];
    for (const room of [...this.#rooms.values()]) {
      const memberIds = [...room.state.members.values()]
        .filter((member) => member.accountId === accountId)
        .map((member) => member.memberId);
      for (const memberId of memberIds) {
        this.#publisher.disconnectMember(memberId, 4004, "账号已被管理员禁用");
      }
      if (memberIds.length > 0) {
        removals.push(
          (async () => {
            for (const memberId of memberIds) {
              if (room.destroyed || !room.state.members.has(memberId)) continue;
              await room.leave(memberId);
            }
          })(),
        );
      }
    }
    await Promise.all(removals);
  }

  closeAll(reason = "site_disabled", message = "网站服务已关闭"): void {
    for (const room of [...this.#rooms.values()]) {
      room.destroy(reason, message);
    }
  }

  closeGame(gameId: string, reason = "game_disabled", message = "游戏服务已关闭"): void {
    for (const room of [...this.#rooms.values()]) {
      if (room.state.gameId === gameId) {
        room.destroy(reason, message);
      }
    }
  }

  #createJoinTicket(input: Omit<JoinTicketState, "expiresAt">) {
    const token = randomBytes(32).toString("base64url");
    const ticket: JoinTicketState = { ...input, expiresAt: Date.now() + JOIN_TICKET_TTL_MS };
    this.#joinTickets.set(token, ticket);
    const timer = setTimeout(() => this.#expireJoinTicket(token, ticket), JOIN_TICKET_TTL_MS);
    timer.unref();
    this.#joinTicketTimers.set(token, timer);
    return { expiresAt: ticket.expiresAt, roomId: ticket.roomId, token };
  }

  #deleteJoinTicket(token: string): void {
    this.#joinTickets.delete(token);
    const timer = this.#joinTicketTimers.get(token);
    if (timer) clearTimeout(timer);
    this.#joinTicketTimers.delete(token);
  }

  #expireJoinTicket(token: string, ticket: JoinTicketState): void {
    if (this.#joinTickets.get(token) !== ticket) return;
    this.#deleteJoinTicket(token);
    if (ticket.source !== "create" || ticket.memberId === undefined) return;
    const room = this.#rooms.get(ticket.roomId);
    const member = room?.state.members.get(ticket.memberId);
    if (
      room &&
      !room.destroyed &&
      member?.connectionStatus === "offline" &&
      member.connectionId === undefined
    ) {
      void room
        .leave(member.memberId)
        .catch(() => room.destroy("internal_error", "清理未连接的创建者失败"));
    }
  }

  #ensureSessionActive(session: Session, expectedAccountId = session.accountId): void {
    const currentSession = this.#repositories.sessions.findById(session.id);
    const account = this.#repositories.accounts.findById(expectedAccountId);
    if (
      !currentSession ||
      currentSession.accountId !== expectedAccountId ||
      currentSession.revokedAt !== null ||
      currentSession.expiresAt <= Date.now() ||
      !account ||
      account.id !== session.accountId ||
      account.status !== "enabled"
    ) {
      throw new HttpError(401, "AUTH_SESSION_EXPIRED", "登录状态已失效，请重新登录");
    }
  }

  #ensureSiteEnabled(): void {
    if (this.#repositories.services.initializeSite().enabled === false) {
      throw new HttpError(503, "SITE_DISABLED", "网站正在维护");
    }
  }

  #ensureGameEnabled(gameId: string): void {
    const settings = this.#repositories.services.findGame(gameId);
    if (!settings?.enabled) {
      throw new HttpError(503, "GAME_SERVICE_DISABLED", "游戏服务当前不可用");
    }
  }

  #ensureRoomAvailableForSession(sessionId: SessionId, roomId: RoomId): void {
    if (this.bindingForSession(sessionId, roomId)) {
      throw new HttpError(409, "CONNECTION_ROOM_CONFLICT", "当前设备已经加入该房间", {
        resumeAvailable: true,
        roomId,
      });
    }
  }

  #validateBinding(sessionId: SessionId, roomId: RoomId, memberId: MemberId): boolean {
    const room = this.#rooms.get(roomId);
    const member = room?.destroyed ? undefined : room?.state.members.get(memberId);
    if (member?.sessionId === sessionId) return true;
    const bindings = this.#membersBySession.get(sessionId);
    if (bindings?.get(roomId) === memberId) {
      bindings.delete(roomId);
      if (bindings.size === 0) this.#membersBySession.delete(sessionId);
    }
    return false;
  }

  #throwPasswordCapacityError(error: unknown): never {
    if (error instanceof RoomPasswordCapacityError) {
      throw new HttpError(429, "RATE_ROOM_LIMIT", "房间密码操作繁忙，请稍后重试", {
        retryAfterSeconds: 1,
      });
    }
    throw error;
  }

  #publisherProxy(): RoomPublisher {
    return {
      disconnectConnection: (...arguments_) => this.#publisher.disconnectConnection(...arguments_),
      disconnectMember: (...arguments_) => this.#publisher.disconnectMember(...arguments_),
      publishClosed: (...arguments_) => this.#publisher.publishClosed(...arguments_),
      publishSnapshot: (...arguments_) => this.#publisher.publishSnapshot(...arguments_),
    };
  }

  #setMemberBinding(sessionId: SessionId, roomId: RoomId, memberId: MemberId): void {
    let bindings = this.#membersBySession.get(sessionId);
    if (!bindings) {
      bindings = new Map();
      this.#membersBySession.set(sessionId, bindings);
    }
    bindings.set(roomId, memberId);
  }

  #releaseMemberBinding(roomId: RoomId, member: RoomMemberState): void {
    const bindings = this.#membersBySession.get(member.sessionId);
    if (bindings?.get(roomId) !== member.memberId) return;
    bindings.delete(roomId);
    if (bindings.size === 0) {
      this.#membersBySession.delete(member.sessionId);
    }
  }

  #removeDestroyedRoom(state: RoomState): void {
    this.#rooms.delete(state.roomId);
    this.#inviteRooms.delete(state.inviteToken);
    for (const member of state.members.values()) {
      this.#releaseMemberBinding(state.roomId, member);
    }
  }
}

function normalizeRoomName(input: string): string {
  const value = input.trim();
  const length = Array.from(value).length;
  if (length < 1 || length > 30) {
    throw new HttpError(400, "VALIDATION_FAILED", "房间名长度必须为 1 到 30 个字符");
  }
  return value;
}
