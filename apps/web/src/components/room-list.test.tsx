import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { gameIdSchema, roomIdSchema } from "@tabletop/protocol";
import type { RoomSummary } from "@tabletop/protocol/http";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoomList } from "./room-list";

describe("RoomList", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("returns to the account current room without requesting a new join ticket", async () => {
    const room: RoomSummary = {
      gameId: gameIdSchema.parse("gomoku"),
      hasPassword: true,
      hostName: "房主",
      joinable: true,
      maxPlayers: 2,
      maxSpectators: 10,
      name: "掉线恢复房",
      occupiedSeats: 2,
      roomId: roomIdSchema.parse("room-resumable"),
      spectatorCount: 0,
      status: "playing",
    };
    const router = createMemoryRouter(
      [
        {
          element: <RoomList currentRoomId={room.roomId} rooms={[room]} />,
          path: "/games/gomoku",
        },
        { element: <div>已打开恢复房间</div>, path: "/rooms/:roomId" },
      ],
      { initialEntries: ["/games/gomoku"] },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "返回房间" }));
    expect(await screen.findByText("已打开恢复房间")).toBeInTheDocument();
  });

  it("asks whether to return when entering a different room", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const room: RoomSummary = {
      gameId: gameIdSchema.parse("gomoku"),
      hasPassword: false,
      hostName: "其他房主",
      joinable: true,
      maxPlayers: 2,
      maxSpectators: 10,
      name: "其他房间",
      occupiedSeats: 1,
      roomId: roomIdSchema.parse("room-other"),
      spectatorCount: 0,
      status: "lobby",
    };
    const currentRoomId = roomIdSchema.parse("room-current");
    const router = createMemoryRouter(
      [
        {
          element: <RoomList currentRoomId={currentRoomId} rooms={[room]} />,
          path: "/games/gomoku",
        },
        { element: <div>已返回当前房间</div>, path: "/rooms/:roomId" },
      ],
      { initialEntries: ["/games/gomoku"] },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "进入" }));
    expect(confirm).toHaveBeenCalledWith("当前账号已经在另一个房间中，是否返回当前房间？");
    expect(await screen.findByText("已返回当前房间")).toBeInTheDocument();
  });
});
