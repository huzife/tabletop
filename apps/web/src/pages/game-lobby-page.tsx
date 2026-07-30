import { ArrowLeft, Bot, KeyRound, Plus, Settings2, UsersRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { AnyGameWebModuleV1 } from "@tabletop/game-sdk/web";
import { roomIdSchema, type JsonValue } from "@tabletop/protocol";
import type { GameCatalogEntry } from "@tabletop/protocol/http";
import { Badge, Button, TextField } from "@tabletop/ui";

import { ApiClientError } from "../api/client";
import { useAuth } from "../auth";
import { GameMark } from "../components/game-mark";
import { RoomList } from "../components/room-list";
import { webGameRegistry } from "../games/registry";
import { useCreateRoom, useGames, useRooms } from "../hooks/use-lobby";
import { NotFoundPage } from "./not-found-page";

export function GameLobbyPage() {
  const { gameId } = useParams();
  const gamesQuery = useGames();
  const game = gamesQuery.data?.games.find((candidate) => candidate.gameId === gameId);
  const gameModule = webGameRegistry
    .list()
    .find((candidate) => candidate.shared.manifest.gameId === gameId);

  if (gamesQuery.isPending) {
    return <div className="page inline-status">正在加载游戏大厅</div>;
  }
  if (gamesQuery.isError) {
    return (
      <div className="page page--narrow">
        <div className="warning-notice" role="alert">
          {gamesQuery.error.message}
        </div>
      </div>
    );
  }
  if (!game || !gameModule) return <NotFoundPage />;
  return <GameLobbyContent game={game} gameModule={gameModule} key={game.gameId} />;
}

function GameLobbyContent({
  game,
  gameModule,
}: {
  readonly game: GameCatalogEntry;
  readonly gameModule: AnyGameWebModuleV1;
}) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const roomsQuery = useRooms(game.gameId);
  const createRoom = useCreateRoom();
  const [mode, setMode] = useState<"online" | "practice">("online");
  const [roomName, setRoomName] = useState(
    `${session?.displayName ?? "玩家"}的${game.displayName}房间`,
  );
  const [password, setPassword] = useState("");
  const [practiceBotProfileId, setPracticeBotProfileId] = useState(
    game.botProfiles[0]?.profileId ?? "",
  );
  const [settings, setSettings] = useState<JsonValue>(() =>
    gameModule.shared.settings.schema.parse(gameModule.shared.settings.defaultValue),
  );
  const [createError, setCreateError] = useState("");
  const rooms = roomsQuery.data?.rooms ?? [];
  const currentRoomId = roomsQuery.data?.currentRoomId ?? null;
  const SettingsEditor = gameModule.SettingsEditor;
  const hasBotProfiles = game.botProfiles.length > 0;
  const practiceAvailable = game.capabilities.bots || game.capabilities.soloPractice;

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError("");
    if (currentRoomId !== null) {
      if (window.confirm("当前账号已经在一个房间中，是否返回当前房间？")) {
        navigate(`/rooms/${currentRoomId}`);
      }
      return;
    }
    const parsedSettings = gameModule.shared.settings.schema.safeParse(settings);
    if (!parsedSettings.success) {
      setCreateError("对局设置无效，请检查后重试");
      return;
    }
    try {
      const created = await createRoom.mutateAsync({
        ...(mode === "practice" && hasBotProfiles ? { botProfileId: practiceBotProfileId } : {}),
        gameId: game.gameId,
        name: roomName,
        ...(mode === "online" && password ? { password } : {}),
        practice: mode === "practice",
        settings: parsedSettings.data,
      });
      navigate(`/rooms/${created.roomId}`, {
        state: {
          inviteUrl: created.inviteUrl,
          joinTicket: created.joinTicket,
        },
      });
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "CONNECTION_ROOM_CONFLICT") {
        const parsedCurrentRoomId = roomIdSchema.safeParse(error.details.currentRoomId);
        if (parsedCurrentRoomId.success) {
          if (window.confirm("当前账号已经在一个房间中，是否返回当前房间？")) {
            navigate(`/rooms/${parsedCurrentRoomId.data}`);
          }
          return;
        }
      }
      setCreateError(error instanceof ApiClientError ? error.message : "暂时无法创建房间");
    }
  }

  return (
    <div className="page page--wide">
      <Link className="back-link" to="/">
        <ArrowLeft size={16} /> 返回游戏大厅
      </Link>
      <header className="game-heading">
        <GameMark game={{ id: game.gameId, name: game.displayName }} size="large" />
        <div>
          <div className="title-with-status">
            <h1>{game.displayName}</h1>
            <Badge tone={game.enabled ? "success" : "neutral"}>
              {game.enabled ? "服务正常" : "服务已停用"}
            </Badge>
          </div>
          <p>{game.description}</p>
        </div>
      </header>

      <div className="lobby-layout">
        <section aria-labelledby="create-room-title" className="create-room-tool">
          <div className="section-heading">
            <div>
              <h2 id="create-room-title">创建房间</h2>
              <p>开局前仍可在房间内修改设置。</p>
            </div>
            <Plus size={20} />
          </div>
          <form className="form-stack" onSubmit={handleCreate}>
            <TextField
              label="房间名称"
              maxLength={30}
              onChange={(event) => setRoomName(event.target.value)}
              required
              value={roomName}
            />
            <TextField
              label="房间密码（可选）"
              maxLength={128}
              onChange={(event) => setPassword(event.target.value)}
              disabled={mode === "practice"}
              type="password"
              value={password}
            />
            <fieldset className="segmented-field">
              <legend>模式</legend>
              <div className="segmented-control">
                <button
                  aria-pressed={mode === "online"}
                  onClick={() => setMode("online")}
                  type="button"
                >
                  <UsersRound size={16} /> 在线对局
                </button>
                <button
                  aria-pressed={mode === "practice"}
                  disabled={!practiceAvailable}
                  onClick={() => setMode("practice")}
                  type="button"
                >
                  <Bot size={16} /> 单人练习
                </button>
              </div>
            </fieldset>
            {mode === "practice" && hasBotProfiles ? (
              <label className="select-field">
                <span>AI 难度</span>
                <select
                  disabled={createRoom.isPending}
                  onChange={(event) => setPracticeBotProfileId(event.currentTarget.value)}
                  value={practiceBotProfileId}
                >
                  {game.botProfiles.map((profile) => (
                    <option key={profile.profileId} value={profile.profileId}>
                      {profile.displayName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="plugin-settings-slot">
              <Settings2 size={18} />
              <div>
                <strong>对局设置</strong>
                {SettingsEditor ? (
                  <SettingsEditor
                    disabled={!game.enabled || createRoom.isPending}
                    onChange={setSettings}
                    value={settings}
                  />
                ) : (
                  <span>此游戏使用默认设置</span>
                )}
              </div>
            </div>
            {createError ? (
              <div className="warning-notice" role="alert">
                {createError}
              </div>
            ) : null}
            <Button
              disabled={
                !game.enabled ||
                createRoom.isPending ||
                !roomName.trim() ||
                (mode === "practice" && hasBotProfiles && !practiceBotProfileId)
              }
              type="submit"
            >
              <Plus size={17} /> {createRoom.isPending ? "正在创建" : "创建并进入"}
            </Button>
          </form>
        </section>

        <section aria-labelledby="game-rooms-title" className="lobby-rooms">
          <div className="section-heading">
            <div>
              <h2 id="game-rooms-title">{game.displayName}房间</h2>
              <p>邀请链接进入房间时无需填写房间密码。</p>
            </div>
            {mode === "online" && password ? (
              <KeyRound aria-label="新房间将使用密码" size={19} />
            ) : null}
          </div>
          {roomsQuery.isPending ? <div className="inline-status">正在加载公开房间</div> : null}
          {roomsQuery.isError ? (
            <div className="warning-notice" role="alert">
              {roomsQuery.error.message}
            </div>
          ) : null}
          <RoomList currentRoomId={currentRoomId} rooms={rooms} />
        </section>
      </div>
    </div>
  );
}
