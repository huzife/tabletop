import type { GameConnectionStateV1 } from "@tabletop/game-sdk/web";
import {
  roomIdSchema,
  type JsonObject,
  type JsonValue,
  type RoomMember,
  type RoomSeat,
} from "@tabletop/protocol";
import { Badge, Button, IconButton } from "@tabletop/ui";
import {
  ArrowLeft,
  Bot,
  Check,
  CircleDot,
  Copy,
  Crown,
  Eye,
  LogOut,
  Play,
  RefreshCw,
  Settings2,
  UserMinus,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";

import { useAuth } from "../auth";
import { GameMark } from "../components/game-mark";
import { RoomChat } from "../components/room-chat";
import { webGameRegistry } from "../games/registry";
import { useGames } from "../hooks/use-lobby";
import {
  captureRoomEntryContext,
  clearRoomEntryContext,
  type RoomEntryContext,
} from "../rooms/entry-context";
import { useRoomSocket, type RoomConnectionStatus } from "../rooms/use-room-socket";
import { NotFoundPage } from "./not-found-page";

const ROOM_STATUS_LABELS = {
  lobby: "等待中",
  playing: "对局中",
  post_match: "已结束",
} as const;

const CONNECTION_LABELS: Readonly<
  Record<
    RoomConnectionStatus,
    { readonly label: string; readonly tone: "danger" | "neutral" | "success" | "warning" }
  >
> = {
  closed: { label: "房间已关闭", tone: "neutral" },
  connected: { label: "已连接", tone: "success" },
  connecting: { label: "正在连接", tone: "neutral" },
  offline: { label: "连接中断", tone: "danger" },
  reconnecting: { label: "正在重连", tone: "warning" },
};

const MEMBER_CONNECTION_LABELS = {
  connected: "在线",
  offline: "已离线",
  reconnecting: "等待重连",
} as const;

const CONTROLLER_LABELS = {
  bot: "AI",
  fallback: "临时接管",
  human: "真人",
} as const;

export function RoomPage() {
  const { roomId: roomIdInput = "" } = useParams();
  const parsedRoomId = roomIdSchema.safeParse(roomIdInput);
  if (!parsedRoomId.success) return <NotFoundPage />;
  return <ConnectedRoomPage key={parsedRoomId.data} roomId={parsedRoomId.data} />;
}

function ConnectedRoomPage({ roomId }: { readonly roomId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { session } = useAuth();
  const [entry] = useState<RoomEntryContext>(() => captureRoomEntryContext(roomId, location.state));
  const socket = useRoomSocket(roomId, entry.joinTicket);
  const gamesQuery = useGames();
  const [copied, setCopied] = useState(false);
  const [localNotice, setLocalNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [roomNameDraft, setRoomNameDraft] = useState("");
  const [settingsDraft, setSettingsDraft] = useState<JsonValue | null>(null);
  const [selectedBotProfiles, setSelectedBotProfiles] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const copiedTimer = useRef<number | undefined>(undefined);
  const snapshot = socket.snapshot;
  const payload = snapshot?.payload;
  const gameModule = payload === undefined ? undefined : webGameRegistry.get(payload.gameId);
  const manifest = gameModule?.shared.manifest;
  const catalogGame = gamesQuery.data?.games.find((game) => game.gameId === payload?.gameId);
  const botProfiles = catalogGame?.botProfiles ?? [];
  const connection = CONNECTION_LABELS[socket.connectionStatus];
  const connected = socket.connectionStatus === "connected";
  const commandBusy = socket.pendingCommandTypes.length > 0;

  useEffect(() => {
    if (location.state === null) return;
    void navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: null,
    });
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

  useEffect(() => {
    if (payload === undefined || settingsOpen) return;
    setRoomNameDraft(payload.room.name);
    setSettingsDraft(payload.settings);
  }, [payload, settingsOpen]);

  useEffect(
    () => () => {
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const currentMember = useMemo(
    () => payload?.members.find((member) => member.accountId === session?.accountId),
    [payload?.members, session?.accountId],
  );
  const currentSeat = useMemo(
    () =>
      payload?.seats.find(
        (seat) =>
          seat.occupant?.kind === "human" && seat.occupant.memberId === currentMember?.memberId,
      ),
    [currentMember?.memberId, payload?.seats],
  );
  const spectators = payload?.members.filter((member) => member.role === "spectator") ?? [];
  const settingsSummary =
    gameModule !== undefined && settingsDraft !== null
      ? gameModule.shared.settings.summarize(settingsDraft as never)
      : [];
  const displayedError = formatSocketError(socket.error, gameModule);

  function sendRevisioned(command: Parameters<typeof socket.sendCommand>[0]): boolean {
    if (!connected || commandBusy) return false;
    return socket.sendCommand(command) !== null;
  }

  function claimSeat(seatId: RoomSeat["seatId"]) {
    if (snapshot === null) return;
    sendRevisioned({
      expectedRevision: snapshot.revision,
      payload: { seatId },
      type: "room.seat.claim",
    });
  }

  function reclaimSeat(seatId: RoomSeat["seatId"]) {
    if (snapshot === null) return;
    sendRevisioned({
      expectedRevision: snapshot.revision,
      payload: { seatId },
      type: "room.seat.reclaim",
    });
  }

  function releaseSeat() {
    if (snapshot === null) return;
    sendRevisioned({
      expectedRevision: snapshot.revision,
      payload: {},
      type: "room.seat.release",
    });
  }

  function addBot(seatId: RoomSeat["seatId"]) {
    if (snapshot === null) return;
    const profileId = selectedBotProfiles[seatId] ?? botProfiles[0]?.profileId;
    if (profileId === undefined) {
      setLocalNotice("当前游戏没有可用的 AI 配置");
      return;
    }
    sendRevisioned({
      expectedRevision: snapshot.revision,
      payload: { profileId, seatId },
      type: "room.bot.add",
    });
  }

  function removeBot(seatId: RoomSeat["seatId"]) {
    if (snapshot === null) return;
    sendRevisioned({
      expectedRevision: snapshot.revision,
      payload: { seatId },
      type: "room.bot.remove",
    });
  }

  function toggleReady() {
    if (snapshot === null || currentSeat?.occupant?.kind !== "human") return;
    sendRevisioned({
      expectedRevision: snapshot.revision,
      payload: { ready: !currentSeat.occupant.ready },
      type: "room.ready.set",
    });
  }

  function startMatch() {
    if (snapshot === null) return;
    sendRevisioned({
      expectedRevision: snapshot.revision,
      payload: {},
      type: "room.match.start",
    });
  }

  function transferHost(accountId: RoomMember["accountId"], displayName: string) {
    if (snapshot === null || !window.confirm(`确认将房主转移给“${displayName}”？`)) return;
    sendRevisioned({
      expectedRevision: snapshot.revision,
      payload: { accountId },
      type: "room.host.transfer",
    });
  }

  function kickMember(memberId: RoomMember["memberId"], displayName: string) {
    if (snapshot === null || !window.confirm(`确认将“${displayName}”移出房间？`)) return;
    sendRevisioned({
      expectedRevision: snapshot.revision,
      payload: { memberId },
      type: "room.member.kick",
    });
  }

  function renameRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (snapshot === null) return;
    const name = roomNameDraft.trim();
    if (!name || name === payload?.room.name) return;
    sendRevisioned({
      expectedRevision: snapshot.revision,
      payload: { name },
      type: "room.rename",
    });
  }

  function updateSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (snapshot === null || gameModule === undefined || settingsDraft === null) return;
    const parsed = gameModule.shared.settings.schema.safeParse(settingsDraft);
    if (!parsed.success) {
      setLocalNotice("对局设置无效，请检查后重试");
      return;
    }
    sendRevisioned({
      expectedRevision: snapshot.revision,
      payload: { settings: parsed.data },
      type: "room.settings.update",
    });
  }

  function sendMessage(text: string): boolean {
    if (!connected || payload?.permissions.canSendChat !== true) return false;
    return socket.sendCommand({ payload: { text }, type: "chat.send" }) !== null;
  }

  function dispatchGameAction(action: JsonObject & { readonly type: string }) {
    if (
      snapshot === null ||
      snapshot.matchId === undefined ||
      gameModule === undefined ||
      !payload?.permissions.canSubmitGameAction
    ) {
      return;
    }
    const parsed = gameModule.shared.actionSchema.safeParse(action);
    if (!parsed.success) {
      setLocalNotice("游戏插件生成了无效操作");
      return;
    }
    sendRevisioned({
      expectedRevision: snapshot.revision,
      matchId: snapshot.matchId,
      payload: parsed.data,
      type: "game.action",
    });
  }

  function dispatchTransientEvent(event: JsonObject & { readonly type: string }) {
    if (
      snapshot === null ||
      snapshot.matchId === undefined ||
      gameModule === undefined ||
      !connected ||
      !payload?.permissions.canSubmitGameAction
    ) {
      return;
    }
    const parsed = gameModule.shared.transientEventSchema?.safeParse(event);
    if (parsed?.success !== true) return;
    socket.sendTransientEvent(snapshot.matchId, parsed.data);
  }

  async function copyInvite() {
    if (entry.inviteUrl === undefined) {
      setLocalNotice("当前入房入口没有可转发的邀请链接");
      return;
    }
    const copiedSuccessfully = await copyText(entry.inviteUrl);
    setCopied(copiedSuccessfully);
    setLocalNotice(copiedSuccessfully ? "邀请链接已复制" : "无法访问系统剪贴板");
    if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1_600);
  }

  function leaveRoom() {
    clearRoomEntryContext(roomId);
    if (connected) socket.sendCommand({ payload: {}, type: "room.leave" });
    window.setTimeout(
      () => navigate(payload === undefined ? "/" : `/games/${payload.gameId}`),
      100,
    );
  }

  if (
    snapshot === null ||
    payload === undefined ||
    gameModule === undefined ||
    manifest === undefined
  ) {
    return (
      <div className="room-page">
        <header className="room-header">
          <div className="room-header__identity">
            <Link aria-label="返回游戏大厅" className="icon-link" to="/">
              <ArrowLeft size={19} />
            </Link>
            <div>
              <div className="room-title-line">
                <h1>正在进入房间</h1>
                <Badge tone={connection.tone}>{connection.label}</Badge>
              </div>
              <span className="room-subtitle">房间 {roomId}</span>
            </div>
          </div>
          <div className="room-header__actions">
            {socket.connectionStatus === "offline" ? (
              <Button onClick={socket.retry} variant="secondary">
                <RefreshCw size={17} /> 重新连接
              </Button>
            ) : null}
            <IconButton
              icon={<LogOut size={18} />}
              label="返回大厅"
              onClick={() => navigate("/")}
            />
          </div>
        </header>
        <div className="game-module-placeholder">
          <div className="game-module-placeholder__content" role="status">
            <RefreshCw size={28} />
            <h2>{displayedError || "正在建立实时连接"}</h2>
            <p>连接成功后将显示房间和对局状态。</p>
          </div>
        </div>
      </div>
    );
  }

  const GameView = gameModule.GameView;
  const SettingsEditor = gameModule.SettingsEditor;
  const gameConnectionState: GameConnectionStateV1 =
    socket.connectionStatus === "connected"
      ? "connected"
      : socket.connectionStatus === "connecting" || socket.connectionStatus === "reconnecting"
        ? "reconnecting"
        : "offline";
  const gameActionPending = socket.pendingCommandTypes.includes("game.action");
  const statusLabel = ROOM_STATUS_LABELS[payload.room.status];

  return (
    <div className="room-page">
      <header className="room-header">
        <div className="room-header__identity">
          <Link
            aria-label={`返回${manifest.displayName}大厅`}
            className="icon-link"
            to={`/games/${payload.gameId}`}
          >
            <ArrowLeft size={19} />
          </Link>
          <GameMark game={{ id: payload.gameId, name: manifest.displayName }} />
          <div>
            <div className="room-title-line">
              <h1>{payload.room.name}</h1>
              <Badge tone={payload.room.status === "playing" ? "success" : "neutral"}>
                {statusLabel}
              </Badge>
            </div>
            <span className="room-subtitle">
              {manifest.displayName} · 修订 {snapshot.revision}
            </span>
          </div>
        </div>
        <div className="room-header__actions">
          {localNotice ? <span className="inline-notice">{localNotice}</span> : null}
          <Badge tone={connection.tone}>
            <span aria-hidden="true" className="status-dot" /> {connection.label}
          </Badge>
          <Button
            disabled={entry.inviteUrl === undefined}
            onClick={() => void copyInvite()}
            title={entry.inviteUrl === undefined ? "当前入口未提供邀请链接" : "复制邀请链接"}
            variant="secondary"
          >
            {copied ? <Check size={17} /> : <Copy size={17} />}
            {copied ? "已复制" : "邀请"}
          </Button>
          {payload.permissions.canRenameRoom || payload.permissions.canUpdateSettings ? (
            <IconButton
              icon={settingsOpen ? <X size={18} /> : <Settings2 size={18} />}
              label={settingsOpen ? "关闭房间设置" : "修改房间设置"}
              onClick={() => {
                setRoomNameDraft(payload.room.name);
                setSettingsDraft(payload.settings);
                setSettingsOpen((open) => !open);
              }}
            />
          ) : null}
          {socket.connectionStatus === "offline" ? (
            <IconButton icon={<RefreshCw size={18} />} label="重新连接" onClick={socket.retry} />
          ) : null}
          <IconButton
            icon={<LogOut size={18} />}
            label="离开房间"
            onClick={leaveRoom}
            tone="danger"
          />
        </div>
      </header>

      <div className="room-workspace">
        <aside aria-label="房间成员" className="room-members">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">成员</span>
              <h2>玩家座位</h2>
            </div>
            <UsersRound size={19} />
          </div>
          <div className="seat-list">
            {payload.seats.map((seat) => {
              const humanOccupant = seat.occupant?.kind === "human" ? seat.occupant : undefined;
              const occupantMember =
                humanOccupant === undefined
                  ? undefined
                  : payload.members.find((member) => member.memberId === humanOccupant.memberId);
              const isHost =
                seat.occupant?.kind === "human" &&
                seat.occupant.memberId === payload.room.hostMemberId;
              const canClaim = payload.permissions.claimableSeatIds.includes(seat.seatId);
              const canReclaim = payload.permissions.reclaimableSeatIds.includes(seat.seatId);
              const canAddBot = payload.permissions.botAddableSeatIds.includes(seat.seatId);
              const canRemoveBot = payload.permissions.botRemovableSeatIds.includes(seat.seatId);
              const canKick =
                occupantMember !== undefined &&
                payload.permissions.kickableMemberIds.includes(occupantMember.memberId);
              const canTransfer =
                occupantMember !== undefined &&
                occupantMember.connectionStatus === "connected" &&
                payload.permissions.canTransferHost &&
                !isHost;
              const profileId = selectedBotProfiles[seat.seatId] ?? botProfiles[0]?.profileId ?? "";

              return (
                <div className="seat-row" key={seat.seatId}>
                  <div className="seat-row__topline">
                    <span className="seat-label">{seat.displayName}</span>
                    {isHost ? <Crown aria-label="房主" className="host-icon" size={15} /> : null}
                  </div>
                  {seat.occupant === null ? (
                    <div>
                      {canClaim ? (
                        <button
                          className="empty-seat-button"
                          disabled={!connected || commandBusy}
                          onClick={() => claimSeat(seat.seatId)}
                          type="button"
                        >
                          <CircleDot size={16} /> 选择座位
                        </button>
                      ) : (
                        <button className="empty-seat-button" disabled type="button">
                          <CircleDot size={16} /> 空座
                        </button>
                      )}
                      {canAddBot ? (
                        <div>
                          <select
                            aria-label={`${seat.displayName} AI 难度`}
                            disabled={!connected || commandBusy || botProfiles.length === 0}
                            onChange={(event) =>
                              setSelectedBotProfiles((current) => ({
                                ...current,
                                [seat.seatId]: event.currentTarget.value,
                              }))
                            }
                            value={profileId}
                          >
                            {botProfiles.map((profile) => (
                              <option
                                key={profile.profileId}
                                title={profile.description}
                                value={profile.profileId}
                              >
                                {profile.displayName}
                              </option>
                            ))}
                          </select>
                          <Button
                            disabled={!connected || commandBusy || !profileId}
                            onClick={() => addBot(seat.seatId)}
                            variant="quiet"
                          >
                            <Bot size={15} /> 添加 AI
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="occupant-row">
                      <span className="avatar-small">
                        {seat.occupant.kind === "human" ? (
                          <UserRound size={16} />
                        ) : (
                          <Bot size={16} />
                        )}
                      </span>
                      <div className="occupant-row__name">
                        <strong>{seat.occupant.displayName}</strong>
                        <span>
                          {seat.controller === null
                            ? "等待控制"
                            : CONTROLLER_LABELS[seat.controller.kind]}
                          {occupantMember === undefined
                            ? ""
                            : ` · ${MEMBER_CONNECTION_LABELS[occupantMember.connectionStatus]}`}
                        </span>
                      </div>
                      {seat.occupant.kind === "human" ? (
                        <Badge tone={seat.occupant.ready ? "success" : "neutral"}>
                          {seat.occupant.ready ? "已准备" : "未准备"}
                        </Badge>
                      ) : null}
                      {canReclaim ? (
                        <Button
                          disabled={!connected || commandBusy}
                          onClick={() => reclaimSeat(seat.seatId)}
                          variant="secondary"
                        >
                          取回
                        </Button>
                      ) : null}
                      {canRemoveBot ? (
                        <IconButton
                          disabled={!connected || commandBusy}
                          icon={<X size={15} />}
                          label="移除 AI"
                          onClick={() => removeBot(seat.seatId)}
                        />
                      ) : null}
                      {canTransfer && occupantMember !== undefined ? (
                        <IconButton
                          disabled={!connected || commandBusy}
                          icon={<Crown size={15} />}
                          label={`将房主转移给${occupantMember.displayName}`}
                          onClick={() =>
                            transferHost(occupantMember.accountId, occupantMember.displayName)
                          }
                        />
                      ) : null}
                      {canKick && occupantMember !== undefined ? (
                        <IconButton
                          disabled={!connected || commandBusy}
                          icon={<UserMinus size={15} />}
                          label={`移出${occupantMember.displayName}`}
                          onClick={() =>
                            kickMember(occupantMember.memberId, occupantMember.displayName)
                          }
                          tone="danger"
                        />
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="spectator-section">
            <div className="panel-heading panel-heading--compact">
              <h2>观众</h2>
              <Badge>
                {spectators.length} / {payload.room.maxSpectators}
              </Badge>
            </div>
            {spectators.length > 0 ? (
              <ul className="spectator-list">
                {spectators.map((spectator) => {
                  const isHost = spectator.memberId === payload.room.hostMemberId;
                  const canKick = payload.permissions.kickableMemberIds.includes(
                    spectator.memberId,
                  );
                  const canTransfer =
                    payload.permissions.canTransferHost &&
                    spectator.connectionStatus === "connected" &&
                    !isHost;
                  return (
                    <li key={spectator.memberId}>
                      <Eye size={15} />
                      <span>
                        {spectator.displayName} ·{" "}
                        {MEMBER_CONNECTION_LABELS[spectator.connectionStatus]}
                      </span>
                      {isHost ? <Crown aria-label="房主" className="host-icon" size={14} /> : null}
                      {canTransfer ? (
                        <IconButton
                          disabled={!connected || commandBusy}
                          icon={<Crown size={14} />}
                          label={`将房主转移给${spectator.displayName}`}
                          onClick={() => transferHost(spectator.accountId, spectator.displayName)}
                        />
                      ) : null}
                      {canKick ? (
                        <IconButton
                          disabled={!connected || commandBusy}
                          icon={<UserMinus size={14} />}
                          label={`移出${spectator.displayName}`}
                          onClick={() => kickMember(spectator.memberId, spectator.displayName)}
                          tone="danger"
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted-text">暂无观众</p>
            )}
          </div>
        </aside>

        <section aria-label={`${manifest.displayName}游戏区域`} className="game-stage">
          {displayedError ? (
            <div className="warning-notice" role="alert">
              <span>{displayedError}</span>
              <IconButton icon={<X size={15} />} label="关闭错误提示" onClick={socket.clearError} />
            </div>
          ) : null}
          {payload.gameView !== null ? (
            <div className="game-module-placeholder" hidden={settingsOpen}>
              <GameView
                actionPending={gameActionPending}
                connectionState={gameConnectionState}
                dispatchAction={dispatchGameAction}
                dispatchTransientEvent={dispatchTransientEvent}
                displayEvents={payload.displayEvents}
                key={snapshot.matchId ?? "no-match"}
                readOnly={!payload.permissions.canSubmitGameAction || commandBusy || !connected}
                transientEvent={socket.transientEvent}
                view={payload.gameView}
              />
            </div>
          ) : !settingsOpen ? (
            <div className="game-module-placeholder">
              <div className="game-module-placeholder__content">
                <GameMark game={{ id: payload.gameId, name: manifest.displayName }} size="large" />
                <span className="eyebrow">{manifest.displayName} · 准备阶段</span>
                <h2>等待玩家准备</h2>
                <p>所有玩家准备并补齐所需座位后，房主即可开始。</p>
              </div>
            </div>
          ) : null}
          {settingsOpen ? (
            <div className="settings-section">
              {payload.permissions.canRenameRoom ? (
                <form className="form-stack" onSubmit={renameRoom}>
                  <label htmlFor="room-name-setting">房间名称</label>
                  <input
                    disabled={!connected || commandBusy}
                    id="room-name-setting"
                    maxLength={30}
                    onChange={(event) => setRoomNameDraft(event.currentTarget.value)}
                    required
                    value={roomNameDraft}
                  />
                  <Button
                    disabled={
                      !connected ||
                      commandBusy ||
                      !roomNameDraft.trim() ||
                      roomNameDraft.trim() === payload.room.name
                    }
                    type="submit"
                    variant="secondary"
                  >
                    保存房间名称
                  </Button>
                </form>
              ) : null}
              {payload.permissions.canUpdateSettings && settingsDraft !== null ? (
                <form className="form-stack" onSubmit={updateSettings}>
                  <strong>对局设置</strong>
                  {SettingsEditor === undefined ? (
                    <div>
                      {settingsSummary.map((item) => (
                        <span key={item.label}>
                          {item.label}：{item.value}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <SettingsEditor
                      disabled={!connected || commandBusy}
                      onChange={setSettingsDraft}
                      value={settingsDraft}
                    />
                  )}
                  <Button disabled={!connected || commandBusy} type="submit" variant="secondary">
                    保存对局设置
                  </Button>
                </form>
              ) : null}
            </div>
          ) : null}
          <div className="game-stage__actions">
            <div>
              <strong>{currentSeat?.displayName ?? "当前为观众"}</strong>
              <span>
                {currentSeat?.occupant?.kind === "human"
                  ? currentSeat.occupant.ready
                    ? "你已经准备"
                    : "等待准备"
                  : "选择空座后可以参与对局"}
              </span>
            </div>
            {payload.permissions.canReleaseSeat ? (
              <Button disabled={!connected || commandBusy} onClick={releaseSeat} variant="quiet">
                退出座位
              </Button>
            ) : null}
            {payload.permissions.canSetReady && currentSeat?.occupant?.kind === "human" ? (
              <Button
                disabled={!connected || commandBusy}
                onClick={toggleReady}
                variant={currentSeat.occupant.ready ? "secondary" : "primary"}
              >
                <Check size={17} />
                {currentSeat.occupant.ready ? "取消准备" : "准备"}
              </Button>
            ) : null}
            {payload.permissions.canStartMatch ? (
              <Button disabled={!connected || commandBusy} onClick={startMatch} variant="secondary">
                <Play size={17} /> 开始游戏
              </Button>
            ) : null}
          </div>
        </section>

        <RoomChat
          canSend={connected && payload.permissions.canSendChat}
          messages={payload.chat}
          onSend={sendMessage}
        />
      </div>
    </div>
  );
}

function formatSocketError(
  error: ReturnType<typeof useRoomSocket>["error"],
  gameModule: ReturnType<typeof webGameRegistry.get>,
): string {
  if (error === null) return "";
  const ruleCode = error.details.ruleCode;
  if (
    error.code === "GAME_ILLEGAL_ACTION" &&
    typeof ruleCode === "string" &&
    gameModule?.formatRuleError !== undefined
  ) {
    return gameModule.formatRuleError(ruleCode, error.details);
  }
  return error.message;
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // HTTP deployments may not expose the modern Clipboard API; use the selection fallback.
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}
