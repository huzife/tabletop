import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountsPage } from "./accounts-page";
import { AuditPage } from "./audit-page";
import { ServicesPage } from "./services-page";

const accountId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const onlineAccountId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const timestamp = "2026-07-16T08:00:00.000Z";

describe("administrator pages", () => {
  beforeEach(() => {
    document.cookie = "tt_csrf=test-csrf; path=/";
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads accounts, prevents online deletion and creates an account through the API", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({
          account: {
            createdAt: timestamp,
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
            online: false,
            status: "enabled",
            updatedAt: timestamp,
            username: "new_user",
          },
        });
      }
      return jsonResponse({
        accounts: [
          {
            createdAt: timestamp,
            id: accountId,
            online: false,
            status: "enabled",
            updatedAt: timestamp,
            username: "alice",
          },
          {
            createdAt: timestamp,
            id: onlineAccountId,
            online: true,
            status: "enabled",
            updatedAt: timestamp,
            username: "bob",
          },
        ],
        pagination: { page: 1, pageSize: 20, total: 2 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage(<AccountsPage />);

    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.getByLabelText("账号在线，不能删除")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "新建账号" }));
    const passwordField = screen.getByLabelText("初始密码");
    const createForm = passwordField.closest("form");
    expect(createForm).not.toBeNull();
    fireEvent.change(within(createForm!).getByLabelText("用户名"), {
      target: { value: "new_user" },
    });
    fireEvent.change(passwordField, { target: { value: "secret12" } });
    fireEvent.click(within(createForm!).getByRole("button", { name: "创建" }));

    expect(await screen.findByText("已创建账号 new_user")).toBeInTheDocument();
    const createCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(createCall?.[0]).toBe("/api/v1/admin/accounts");
    expect(new Headers(createCall?.[1]?.headers).get("x-csrf-token")).toBe("test-csrf");
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      password: "secret12",
      username: "new_user",
    });
  });

  it("updates a registered game service and exposes the maintenance message editor", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT" && url.endsWith("/games/gomoku")) {
        return jsonResponse({
          game: {
            displayName: "五子棋",
            enabled: false,
            gameId: "gomoku",
            updatedAt: timestamp,
          },
        });
      }
      return jsonResponse({
        games: [
          {
            displayName: "五子棋",
            enabled: true,
            gameId: "gomoku",
            updatedAt: timestamp,
          },
        ],
        site: {
          enabled: true,
          maintenanceMessage: "站点维护中",
          updatedAt: timestamp,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage(<ServicesPage />);

    expect(await screen.findByDisplayValue("站点维护中")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "关闭五子棋" }));

    expect(await screen.findByText("五子棋 服务已关闭，相关房间已立即终止")).toBeInTheDocument();
    const updateCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(updateCall?.[0]).toBe("/api/v1/admin/services/games/gomoku");
    expect(updateCall?.[1]?.body).toBe(JSON.stringify({ enabled: false }));
  });

  it("applies exact audit filters and downloads the filtered server CSV", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/audit.csv")) {
        return new Response("audit,csv", {
          headers: { "content-type": "text/csv" },
          status: 200,
        });
      }
      return jsonResponse({
        logs: [
          {
            action: "account.create",
            actorAccountId: accountId,
            actorUsername: "admin_user",
            createdAt: timestamp,
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
            metadata: {},
            requestId: "request-audit-1",
            result: "success",
            sourceIp: "127.0.0.1",
            targetId: onlineAccountId,
            targetLabel: "alice",
            targetType: "account",
          },
        ],
        pagination: { page: 1, pageSize: 20, total: 1 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:audit");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    renderPage(<AuditPage />);

    expect(await screen.findByText("创建账号")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("账号 ID"), { target: { value: accountId } });
    fireEvent.change(screen.getByLabelText("操作代码"), {
      target: { value: "account.create" },
    });
    fireEvent.change(screen.getByLabelText("执行结果"), { target: { value: "success" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => {
          const url = String(input);
          return (
            url.includes(`accountId=${accountId}`) &&
            url.includes("action=account.create") &&
            url.includes("result=success")
          );
        }),
      ).toBe(true);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "检索" })).not.toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    await waitFor(() => expect(createObjectUrl).toHaveBeenCalledOnce());
    expect(
      fetchMock.mock.calls.some(([input]) => {
        const url = String(input);
        return url.includes("/audit.csv?") && url.includes(`accountId=${accountId}`);
      }),
    ).toBe(true);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function renderPage(element: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: 0 },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
}
