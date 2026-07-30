import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { gameIdSchema, roomIdSchema } from "@tabletop/protocol";
import type { RoomSummary } from "@tabletop/protocol/http";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { RoomList } from "./room-list";

describe("RoomList", () => {
  afterEach(cleanup);

  it("opens a resumable room directly without requesting a new join ticket", async () => {
    const room: RoomSummary = {
      gameId: gameIdSchema.parse("gomoku"),
      hasPassword: true,
      hostName: "房主",
      joinable: true,
      maxPlayers: 2,
      maxSpectators: 10,
      name: "掉线恢复房",
      occupiedSeats: 2,
      resumeAvailable: true,
      roomId: roomIdSchema.parse("room-resumable"),
      spectatorCount: 0,
      status: "playing",
    };
    const router = createMemoryRouter(
      [
        { element: <RoomList rooms={[room]} />, path: "/games/gomoku" },
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

    fireEvent.click(screen.getByRole("button", { name: "重新进入" }));
    expect(await screen.findByText("已打开恢复房间")).toBeInTheDocument();
  });
});
