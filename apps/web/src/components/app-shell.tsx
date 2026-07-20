import {
  Gamepad2,
  House,
  LayoutGrid,
  LogOut,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { Badge, IconButton } from "@tabletop/ui";
import { useAuth } from "../auth";
import { useGames } from "../hooks/use-lobby";

function navClassName({ isActive }: { isActive: boolean }) {
  return `app-nav__link${isActive ? " app-nav__link--active" : ""}`;
}

export function AppShell() {
  const { session, signOut } = useAuth();
  const gamesQuery = useGames();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError("");
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (error) {
      console.error("sign out failed", error);
      setSignOutError("退出失败，请重试");
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="app-frame">
      <header className="app-header">
        <NavLink aria-label="Tabletop 首页" className="brand" to="/">
          <span className="brand__mark">
            <Gamepad2 size={22} strokeWidth={2.2} />
          </span>
          <span>Tabletop</span>
        </NavLink>

        <nav aria-label="主导航" className="app-nav">
          <NavLink className={navClassName} end to="/">
            <House size={17} />
            首页
          </NavLink>
          {(gamesQuery.data?.games ?? []).map((game) => (
            <NavLink className={navClassName} key={game.gameId} to={`/games/${game.gameId}`}>
              <LayoutGrid size={17} />
              {game.displayName}
            </NavLink>
          ))}
        </nav>

        <div className="app-header__actions">
          {signOutError ? (
            <span className="header-error" role="alert">
              {signOutError}
            </span>
          ) : null}
          <Badge tone={gamesQuery.isError ? "neutral" : "success"}>
            <span aria-hidden="true" className="status-dot" />
            {gamesQuery.isError ? "服务连接异常" : "服务在线"}
          </Badge>
          {session?.role === "admin" ? (
            <NavLink className={navClassName} to="/admin/accounts">
              <ShieldCheck size={17} />
              管理
            </NavLink>
          ) : null}
          <NavLink className="account-link" to="/account/security">
            <UserRound size={17} />
            <span>{session?.displayName}</span>
            <Settings size={14} />
          </NavLink>
          <IconButton
            disabled={signingOut}
            icon={<LogOut size={18} />}
            label={signingOut ? "正在退出" : "退出登录"}
            onClick={handleSignOut}
          />
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
