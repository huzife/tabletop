import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate, Outlet, useParams, type RouteObject } from "react-router";
import { AuthProvider, RequireAdmin, RequireAnonymous, RequireSession } from "./auth";
import { AppShell } from "./components/app-shell";
import { ApiClientError } from "./api/client";
import { useInviteJoinTicket } from "./hooks/use-lobby";
import { AccountSecurityPage } from "./pages/account-security-page";
import { AccountsPage } from "./pages/admin/accounts-page";
import { AdminLayout } from "./pages/admin/admin-layout";
import { AuditPage } from "./pages/admin/audit-page";
import { ServicesPage } from "./pages/admin/services-page";
import { GameLobbyPage } from "./pages/game-lobby-page";
import { HomePage } from "./pages/home-page";
import { LoginPage } from "./pages/login-page";
import { NotFoundPage } from "./pages/not-found-page";
import { RoomPage } from "./pages/room-page";

function RootProviders() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: false,
            staleTime: 15_000,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Outlet />
      </AuthProvider>
    </QueryClientProvider>
  );
}

function InviteResolver() {
  const { inviteToken } = useParams();
  const ticketQuery = useInviteJoinTicket(inviteToken);
  if (!inviteToken) return <NotFoundPage />;
  if (ticketQuery.isPending) {
    return (
      <main className="session-loading" role="status">
        正在验证邀请链接
      </main>
    );
  }
  if (ticketQuery.isError) {
    return (
      <main className="page page--centered">
        <div className="warning-notice" role="alert">
          {ticketQuery.error instanceof ApiClientError
            ? ticketQuery.error.message
            : "暂时无法进入邀请房间"}
        </div>
      </main>
    );
  }
  return (
    <Navigate
      replace
      state={{
        inviteUrl: window.location.href,
        joinTicket: ticketQuery.data.joinTicket,
      }}
      to={`/rooms/${ticketQuery.data.roomId}`}
    />
  );
}

export function createAppRoutes(): RouteObject[] {
  return [
    {
      element: <RootProviders />,
      children: [
        {
          element: (
            <RequireAnonymous>
              <LoginPage />
            </RequireAnonymous>
          ),
          path: "/login",
        },
        {
          element: (
            <RequireSession>
              <InviteResolver />
            </RequireSession>
          ),
          path: "/invite/:inviteToken",
        },
        {
          element: (
            <RequireSession>
              <AppShell />
            </RequireSession>
          ),
          children: [
            { element: <HomePage />, index: true },
            { element: <GameLobbyPage />, path: "games/:gameId" },
            { element: <RoomPage />, path: "rooms/:roomId" },
            { element: <AccountSecurityPage />, path: "account/security" },
            {
              element: (
                <RequireAdmin>
                  <AdminLayout />
                </RequireAdmin>
              ),
              path: "admin",
              children: [
                { element: <Navigate replace to="accounts" />, index: true },
                { element: <AccountsPage />, path: "accounts" },
                { element: <ServicesPage />, path: "services" },
                { element: <AuditPage />, path: "audit" },
              ],
            },
            { element: <NotFoundPage />, path: "*" },
          ],
        },
      ],
    },
  ];
}
