import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Navigate, useLocation } from "react-router";

import { ApiClientError, authApi, type SessionResponse } from "./api/client";

export interface SessionView {
  readonly accountId: string;
  readonly displayName: string;
  readonly expiresAt: string;
  readonly role: "admin" | "user";
  readonly sessionId: string;
  readonly username: string;
}

interface AuthContextValue {
  readonly loading: boolean;
  readonly session: SessionView | null;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function toSessionView(response: SessionResponse): SessionView {
  return {
    accountId: response.account.id,
    displayName: response.account.username,
    expiresAt: response.session.expiresAt,
    role: response.account.role,
    sessionId: response.session.id,
    username: response.account.username,
  };
}

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void authApi
      .session()
      .then((response) => {
        if (active) setSession(toSessionView(response));
      })
      .catch((error: unknown) => {
        if (active && (!(error instanceof ApiClientError) || error.status !== 401)) {
          console.error("session restore failed", error);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    const response = await authApi.login({ password, username });
    setSession(toSessionView(response));
  }, []);

  const signOut = useCallback(async () => {
    try {
      await authApi.logout();
      setSession(null);
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "AUTH_SESSION_EXPIRED") {
        setSession(null);
        return;
      }
      throw error;
    }
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const response = await authApi.changePassword({ currentPassword, newPassword });
    setSession(toSessionView(response));
  }, []);

  const value = useMemo(
    () => ({ changePassword, loading, session, signIn, signOut }),
    [changePassword, loading, session, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}

function SessionLoading() {
  return (
    <main className="session-loading" role="status">
      正在恢复登录状态
    </main>
  );
}

export function RequireSession({ children }: { readonly children: ReactNode }) {
  const { loading, session } = useAuth();
  const location = useLocation();
  if (loading) return <SessionLoading />;
  if (!session) {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate replace state={{ returnTo }} to="/login" />;
  }
  return children;
}

export function RequireAnonymous({ children }: { readonly children: ReactNode }) {
  const { loading, session } = useAuth();
  if (loading) return <SessionLoading />;
  if (session) return <Navigate replace to="/" />;
  return children;
}

export function RequireAdmin({ children }: { readonly children: ReactNode }) {
  const { session } = useAuth();
  if (session?.role !== "admin") return <Navigate replace to="/" />;
  return children;
}
