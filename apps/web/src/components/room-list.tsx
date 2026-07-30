import { DoorOpen, LockKeyhole, UsersRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { RoomSummary } from "@tabletop/protocol/http";
import { Badge, Button, EmptyState, TextField } from "@tabletop/ui";
import { useNavigate } from "react-router";

import { ApiClientError } from "../api/client";
import { useRoomJoinTicket } from "../hooks/use-lobby";

const statusLabels: Record<RoomSummary["status"], string> = {
  lobby: "等待中",
  playing: "对局中",
  post_match: "已结束",
};

export function RoomList({ rooms }: { rooms: readonly RoomSummary[] }) {
  const navigate = useNavigate();
  const joinTicket = useRoomJoinTicket();
  const [passwordRoomId, setPasswordRoomId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<{
    readonly roomId: string;
    readonly message: string;
  }>();

  async function enterRoom(room: RoomSummary, roomPassword?: string) {
    setJoiningRoomId(room.roomId);
    setJoinError(undefined);
    try {
      const ticket = await joinTicket.mutateAsync({
        roomId: room.roomId,
        ...(roomPassword === undefined ? {} : { password: roomPassword }),
      });
      navigate(`/rooms/${ticket.roomId}`, {
        state: { joinTicket: ticket.joinTicket },
      });
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        error.code === "CONNECTION_ROOM_CONFLICT" &&
        error.details.resumeAvailable === true
      ) {
        navigate(`/rooms/${room.roomId}`);
        return;
      }
      setJoinError({
        roomId: room.roomId,
        message: error instanceof ApiClientError ? error.message : "暂时无法进入房间",
      });
    } finally {
      setJoiningRoomId(null);
    }
  }

  function requestEntry(room: RoomSummary) {
    setJoinError(undefined);
    if (room.resumeAvailable) {
      navigate(`/rooms/${room.roomId}`);
      return;
    }
    if (room.hasPassword) {
      setPassword("");
      setPasswordRoomId(room.roomId);
      return;
    }
    void enterRoom(room);
  }

  function submitPassword(event: FormEvent<HTMLFormElement>, room: RoomSummary) {
    event.preventDefault();
    if (!password) return;
    void enterRoom(room, password);
  }

  if (rooms.length === 0) {
    return (
      <EmptyState
        description="创建一个房间，然后把邀请链接发给朋友。"
        icon={<DoorOpen size={24} />}
        title="暂时没有公开房间"
      />
    );
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>房间</th>
            <th>房主</th>
            <th>人数</th>
            <th>观众</th>
            <th>状态</th>
            <th aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {rooms.map((room) => (
            <tr key={room.roomId}>
              <td>
                <span className="room-name">
                  {room.name}
                  {room.hasPassword ? <LockKeyhole aria-label="有密码" size={14} /> : null}
                </span>
              </td>
              <td>{room.hostName}</td>
              <td>
                {room.occupiedSeats} / {room.maxPlayers}
              </td>
              <td>
                <UsersRound aria-hidden="true" size={15} /> {room.spectatorCount} /{" "}
                {room.maxSpectators}
              </td>
              <td>
                <Badge tone={room.status === "playing" ? "info" : "neutral"}>
                  {statusLabels[room.status]}
                </Badge>
              </td>
              <td>
                {passwordRoomId === room.roomId && !room.resumeAvailable ? (
                  <form
                    className="form-stack form-stack--compact"
                    onSubmit={(event) => submitPassword(event, room)}
                  >
                    <TextField
                      autoFocus
                      error={joinError?.roomId === room.roomId ? joinError.message : undefined}
                      label="房间密码"
                      maxLength={128}
                      onChange={(event) => setPassword(event.currentTarget.value)}
                      required
                      type="password"
                      value={password}
                    />
                    <Button disabled={joiningRoomId !== null} type="submit">
                      {joiningRoomId === room.roomId ? "验证中" : "进入"}
                    </Button>
                    <Button
                      disabled={joiningRoomId !== null}
                      onClick={() => {
                        setPasswordRoomId(null);
                        setJoinError(undefined);
                      }}
                      variant="quiet"
                    >
                      取消
                    </Button>
                  </form>
                ) : (
                  <div>
                    <Button
                      disabled={joiningRoomId !== null}
                      onClick={() => requestEntry(room)}
                      variant="quiet"
                    >
                      {joiningRoomId === room.roomId
                        ? "正在进入"
                        : room.resumeAvailable
                          ? "重新进入"
                          : room.status === "playing"
                            ? "观战"
                            : "进入"}
                    </Button>
                    {joinError?.roomId === room.roomId ? (
                      <span className="ui-field__error" role="alert">
                        {joinError.message}
                      </span>
                    ) : null}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
