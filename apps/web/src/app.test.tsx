import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppRoutes } from "./app";

function renderAt(path: string) {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

describe("web routes", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("redirects anonymous visitors to the login page", async () => {
    vi.stubGlobal("fetch", createFetchMock(null));
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "登录游戏桌" })).toBeInTheDocument();
  });

  it("renders the administrator service route for an admin session", async () => {
    vi.stubGlobal("fetch", createFetchMock("admin"));

    renderAt("/admin/services");
    expect(await screen.findByRole("heading", { name: "游戏服务" })).toBeInTheDocument();
    expect(screen.queryByText("房间管理")).not.toBeInTheDocument();
  });

  it("redirects a regular account away from administrator routes", async () => {
    vi.stubGlobal("fetch", createFetchMock("user"));

    renderAt("/admin/services");
    expect(await screen.findByRole("heading", { name: "选择一张游戏桌" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "游戏服务" })).not.toBeInTheDocument();
  });

  it("keeps the authenticated screen when logout is not confirmed", async () => {
    vi.stubGlobal("fetch", createFetchMock("user", { logoutFails: true }));
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "选择一张游戏桌" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("退出失败，请重试");
    expect(screen.getByRole("heading", { name: "选择一张游戏桌" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeEnabled();
  });

  it("advertises solo practice games in the catalog", async () => {
    vi.stubGlobal("fetch", createFetchMock("user", { games: [soloBilliardsCatalogEntry()] }));

    renderAt("/");

    expect(await screen.findByRole("heading", { name: "台球" })).toBeInTheDocument();
    expect(screen.getByText("单人练习")).toBeInTheDocument();
  });

  it("creates solo practice without showing or submitting an AI profile", async () => {
    let createRoomBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      createFetchMock("user", {
        games: [soloBilliardsCatalogEntry()],
        onCreateRoom: (body) => {
          createRoomBody = body;
        },
      }),
    );

    renderAt("/games/billiards");
    expect(await screen.findByRole("heading", { name: "台球" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "单人练习" }));

    expect(screen.getByLabelText("房间密码（可选）")).toBeDisabled();
    expect(screen.queryByText("AI 难度")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建并进入" }));

    await waitFor(() => expect(createRoomBody).toBeDefined());
    expect(createRoomBody).toMatchObject({
      gameId: "billiards",
      practice: true,
      settings: { mode: "chinese-eight-ball" },
    });
    expect(createRoomBody).not.toHaveProperty("botProfileId");
  });
});

function createFetchMock(
  role: "admin" | "user" | null,
  options: {
    readonly games?: readonly unknown[];
    readonly logoutFails?: boolean;
    readonly onCreateRoom?: (body: Record<string, unknown>) => void;
  } = {},
) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith("/auth/session")) {
      if (role === null) {
        return jsonResponse(
          {
            error: {
              code: "AUTH_SESSION_EXPIRED",
              details: {},
              message: "登录状态已失效，请重新登录",
              requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            },
          },
          401,
        );
      }
      return jsonResponse({
        account: { id: `account-${role}`, role, username: `${role}_user` },
        session: {
          expiresAt: "2026-08-15T10:00:00.000Z",
          id: `session-${role}`,
        },
      });
    }
    if (url.endsWith("/admin/services")) {
      return jsonResponse({
        games: [],
        site: {
          enabled: true,
          maintenanceMessage: "网站维护中",
          updatedAt: "2026-07-16T10:00:00.000Z",
        },
      });
    }
    if (url.endsWith("/auth/logout")) {
      return options.logoutFails
        ? jsonResponse(
            {
              error: {
                code: "INTERNAL_ERROR",
                details: {},
                message: "服务器暂时无法处理请求",
                requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
              },
            },
            500,
          )
        : new Response(null, { status: 204 });
    }
    if (url.endsWith("/games")) return jsonResponse({ games: options.games ?? [] });
    if (url.endsWith("/rooms") && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      options.onCreateRoom?.(body);
      return jsonResponse(
        {
          inviteUrl: "https://tabletop.test/invite/test-invite-token-1234",
          joinTicket: "test-join-ticket-1234567890",
          joinTicketExpiresAt: "2026-08-15T10:00:00.000Z",
          roomId: "room-test",
        },
        201,
      );
    }
    if (url.includes("/rooms")) return jsonResponse({ rooms: [] });
    throw new Error(`unexpected request: ${url}`);
  });
}

function soloBilliardsCatalogEntry() {
  return {
    apiVersion: 1,
    botProfiles: [],
    capabilities: {
      bots: false,
      hiddenInformation: false,
      manualSeatReclaim: false,
      midgameJoin: false,
      soloPractice: true,
      spectators: true,
      temporaryController: false,
      timers: false,
    },
    description: "支持单人练习的台球游戏",
    displayName: "台球",
    enabled: true,
    gameId: "billiards",
    interactionMode: "turn_based",
    maxPlayers: 2,
    minPlayers: 2,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}
