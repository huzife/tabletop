import { FileClock, Power, ShieldCheck, UsersRound } from "lucide-react";
import { NavLink, Outlet } from "react-router";

function tabClassName({ isActive }: { isActive: boolean }) {
  return `admin-tab${isActive ? " admin-tab--active" : ""}`;
}

export function AdminLayout() {
  return (
    <div className="page page--wide admin-page">
      <header className="page-heading page-heading--split">
        <div>
          <span className="eyebrow">管理员</span>
          <h1>站点管理</h1>
          <p>管理账号准入、服务状态和后台审计记录。</p>
        </div>
        <ShieldCheck aria-hidden="true" className="heading-icon" size={38} />
      </header>
      <nav aria-label="管理页面" className="admin-tabs">
        <NavLink className={tabClassName} to="accounts">
          <UsersRound size={17} /> 账号
        </NavLink>
        <NavLink className={tabClassName} to="services">
          <Power size={17} /> 服务
        </NavLink>
        <NavLink className={tabClassName} to="audit">
          <FileClock size={17} /> 审计
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
