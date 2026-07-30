import { ArrowRight, DoorOpen, UsersRound } from "lucide-react";
import { Badge } from "@tabletop/ui";
import { Link } from "react-router";

import { GameMark } from "../components/game-mark";
import { RoomList } from "../components/room-list";
import { useGames, useRooms } from "../hooks/use-lobby";

export function HomePage() {
  const gamesQuery = useGames();
  const roomsQuery = useRooms();
  const games = gamesQuery.data?.games ?? [];
  const rooms = roomsQuery.data?.rooms ?? [];
  const currentRoomId = roomsQuery.data?.currentRoomId ?? null;
  const currentRoom = rooms.find((room) => room.roomId === currentRoomId);

  return (
    <div className="page page--wide">
      <header className="page-heading page-heading--split">
        <div>
          <span className="eyebrow">游戏大厅</span>
          <h1>选择一张游戏桌</h1>
        </div>
        <div className="summary-strip" aria-label="大厅概况">
          <span>
            <DoorOpen size={17} /> {rooms.length} 个公开房间
          </span>
          <span>
            <UsersRound size={17} /> 熟人联机
          </span>
        </div>
      </header>

      {currentRoomId !== null ? (
        <section aria-labelledby="current-room-title" className="current-room-banner">
          <div>
            <span className="eyebrow">当前房间</span>
            <h2 id="current-room-title">{currentRoom?.name ?? "已加入的房间"}</h2>
            <p>当前账号已有所在房间，可直接返回继续游戏。</p>
          </div>
          <Link className="action-link" to={`/rooms/${currentRoomId}`}>
            返回当前房间
            <ArrowRight size={17} />
          </Link>
        </section>
      ) : null}

      <section aria-labelledby="games-title" className="page-section">
        <div className="section-heading">
          <h2 id="games-title">游戏目录</h2>
        </div>
        {gamesQuery.isPending ? <div className="inline-status">正在加载游戏目录</div> : null}
        {gamesQuery.isError ? (
          <div className="warning-notice" role="alert">
            {gamesQuery.error.message}
          </div>
        ) : null}
        <div className="game-list">
          {games.map((game) => (
            <article className="game-row" key={game.gameId}>
              <GameMark game={{ id: game.gameId, name: game.displayName }} size="large" />
              <div className="game-row__body">
                <div className="game-row__title">
                  <h3>{game.displayName}</h3>
                  <Badge tone={game.enabled ? "success" : "neutral"}>
                    {game.enabled ? "可用" : "已停用"}
                  </Badge>
                </div>
                <p>{game.description}</p>
                <div className="metadata-line">
                  <span>
                    {game.minPlayers === game.maxPlayers
                      ? `${game.minPlayers} 人`
                      : `${game.minPlayers} - ${game.maxPlayers} 人`}
                  </span>
                  <span>在线对局</span>
                  {game.capabilities.bots || game.capabilities.soloPractice ? (
                    <span>单人练习</span>
                  ) : null}
                </div>
              </div>
              {game.enabled ? (
                <Link className="action-link" to={`/games/${game.gameId}`}>
                  进入大厅
                  <ArrowRight size={17} />
                </Link>
              ) : (
                <span className="action-link action-link--disabled">暂不可用</span>
              )}
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="rooms-title" className="page-section">
        <div className="section-heading">
          <h2 id="rooms-title">公开房间</h2>
        </div>
        <RoomList currentRoomId={currentRoomId} rooms={rooms} />
      </section>
    </div>
  );
}
