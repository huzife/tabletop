import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, IconButton, TextField } from "@tabletop/ui";
import { Ban, KeyRound, Plus, Search, Trash2, UserCheck, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { adminApi, ApiClientError } from "../../api/client";

const PAGE_SIZE = 20;

type AccountStatusFilter = "all" | "disabled" | "enabled";

interface AccountFilters {
  readonly status: AccountStatusFilter;
  readonly username: string;
}

interface AccountTarget {
  readonly id: string;
  readonly username: string;
}

const initialFilters: AccountFilters = { status: "all", username: "" };

export function AccountsPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [draftFilters, setDraftFilters] = useState<AccountFilters>(initialFilters);
  const [filters, setFilters] = useState<AccountFilters>(initialFilters);
  const [showCreate, setShowCreate] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [resetTarget, setResetTarget] = useState<AccountTarget>();
  const [resetPassword, setResetPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");

  const accountsQuery = useQuery({
    queryFn: () =>
      adminApi.accounts({
        page,
        pageSize: PAGE_SIZE,
        ...(filters.status === "all" ? {} : { status: filters.status }),
        ...(filters.username ? { username: filters.username } : {}),
      }),
    queryKey: ["admin", "accounts", page, filters],
  });

  const refreshAccounts = () => queryClient.invalidateQueries({ queryKey: ["admin", "accounts"] });

  const createMutation = useMutation({
    mutationFn: (input: { password: string; username: string }) => adminApi.createAccount(input),
    onSuccess: async ({ account }) => {
      setUsername("");
      setPassword("");
      setShowCreate(false);
      setPage(1);
      setNotice(`已创建账号 ${account.username}`);
      await refreshAccounts();
    },
    onError: (cause) => setActionError(errorMessage(cause, "账号创建失败")),
  });

  const statusMutation = useMutation({
    mutationFn: (target: AccountTarget & { status: "disabled" | "enabled" }) =>
      adminApi.updateAccount(target.id, target.status),
    onSuccess: async ({ account }) => {
      setNotice(`${account.username} 已${account.status === "enabled" ? "启用" : "禁用"}`);
      await refreshAccounts();
    },
    onError: (cause) => setActionError(errorMessage(cause, "账号状态更新失败")),
  });

  const resetMutation = useMutation({
    mutationFn: (input: AccountTarget & { newPassword: string }) =>
      adminApi.resetPassword(input.id, input.newPassword),
    onSuccess: async (_response, target) => {
      setResetTarget(undefined);
      setResetPassword("");
      setNotice(`已重置 ${target.username} 的密码，现有登录会话已注销`);
      await refreshAccounts();
    },
    onError: (cause) => setActionError(errorMessage(cause, "密码重置失败")),
  });

  const deleteMutation = useMutation({
    mutationFn: (target: AccountTarget) => adminApi.deleteAccount(target.id),
    onSuccess: async (_response, target) => {
      setNotice(`已删除账号 ${target.username}`);
      if ((accountsQuery.data?.accounts.length ?? 0) === 1 && page > 1) {
        setPage((current) => current - 1);
      }
      await refreshAccounts();
    },
    onError: (cause) => setActionError(errorMessage(cause, "账号删除失败")),
  });

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilters({ ...draftFilters, username: draftFilters.username.trim() });
    setPage(1);
  }

  function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username.trim() || password.length < 6) return;
    clearFeedback();
    createMutation.mutate({ password, username });
  }

  function submitPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetTarget || resetPassword.length < 6) return;
    clearFeedback();
    resetMutation.mutate({ ...resetTarget, newPassword: resetPassword });
  }

  function openPasswordReset(target: AccountTarget) {
    clearFeedback();
    setResetTarget(target);
    setResetPassword("");
  }

  function deleteAccount(target: AccountTarget) {
    if (!window.confirm(`确定永久删除账号 ${target.username}？此操作无法撤销。`)) return;
    clearFeedback();
    deleteMutation.mutate(target);
  }

  function clearFeedback() {
    setActionError("");
    setNotice("");
  }

  const data = accountsQuery.data;
  const totalPages = Math.max(1, Math.ceil((data?.pagination.total ?? 0) / PAGE_SIZE));
  const accountActionPending =
    statusMutation.isPending || resetMutation.isPending || deleteMutation.isPending;

  return (
    <section aria-labelledby="accounts-title" className="admin-section">
      <div className="section-heading">
        <div>
          <h2 id="accounts-title">账号管理</h2>
          <p>普通用户只能由管理员创建；用户名不区分英文字母大小写。</p>
        </div>
        <Button
          disabled={createMutation.isPending}
          onClick={() => {
            clearFeedback();
            setShowCreate((current) => !current);
          }}
        >
          <UserPlus size={17} /> 新建账号
        </Button>
      </div>

      {notice ? (
        <div className="inline-status" role="status">
          {notice}
        </div>
      ) : null}
      {actionError ? (
        <div className="warning-notice" role="alert">
          {actionError}
        </div>
      ) : null}

      {showCreate ? (
        <form className="inline-form" onSubmit={createAccount}>
          <TextField
            autoComplete="off"
            label="用户名"
            maxLength={32}
            minLength={3}
            onChange={(event) => setUsername(event.target.value)}
            required
            value={username}
          />
          <TextField
            autoComplete="new-password"
            label="初始密码"
            maxLength={128}
            minLength={6}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          <div className="inline-form__actions">
            <Button disabled={createMutation.isPending} type="submit">
              <Plus size={17} /> {createMutation.isPending ? "正在创建" : "创建"}
            </Button>
            <Button
              disabled={createMutation.isPending}
              onClick={() => setShowCreate(false)}
              variant="quiet"
            >
              取消
            </Button>
          </div>
        </form>
      ) : null}

      {resetTarget ? (
        <form className="inline-form" onSubmit={submitPasswordReset}>
          <TextField disabled label="重置账号" value={resetTarget.username} />
          <TextField
            autoComplete="new-password"
            label="新密码"
            maxLength={128}
            minLength={6}
            onChange={(event) => setResetPassword(event.target.value)}
            required
            type="password"
            value={resetPassword}
          />
          <div className="inline-form__actions">
            <Button disabled={resetMutation.isPending || resetPassword.length < 6} type="submit">
              <KeyRound size={17} /> {resetMutation.isPending ? "正在重置" : "确认重置"}
            </Button>
            <Button
              disabled={resetMutation.isPending}
              onClick={() => setResetTarget(undefined)}
              variant="quiet"
            >
              取消
            </Button>
          </div>
        </form>
      ) : null}

      <form className="filter-bar" onSubmit={applyFilters}>
        <TextField
          label="用户名"
          maxLength={32}
          onChange={(event) =>
            setDraftFilters((current) => ({ ...current, username: event.target.value }))
          }
          placeholder="搜索用户名"
          value={draftFilters.username}
        />
        <label className="select-field">
          <span>账号状态</span>
          <select
            onChange={(event) =>
              setDraftFilters((current) => ({
                ...current,
                status: event.target.value as AccountStatusFilter,
              }))
            }
            value={draftFilters.status}
          >
            <option value="all">全部状态</option>
            <option value="enabled">正常</option>
            <option value="disabled">已禁用</option>
          </select>
        </label>
        <Button disabled={accountsQuery.isFetching} type="submit" variant="secondary">
          <Search size={17} /> {accountsQuery.isFetching ? "正在检索" : "检索"}
        </Button>
      </form>

      {accountsQuery.isPending ? (
        <div className="inline-status" role="status">
          正在加载账号
        </div>
      ) : null}
      {accountsQuery.isError ? (
        <div className="warning-notice" role="alert">
          {errorMessage(accountsQuery.error, "账号加载失败")}
        </div>
      ) : null}

      {data ? (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>状态</th>
                  <th>连接</th>
                  <th>创建时间</th>
                  <th>最近更新</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.accounts.length === 0 ? (
                  <tr>
                    <td colSpan={6}>没有符合条件的账号</td>
                  </tr>
                ) : (
                  data.accounts.map((account) => {
                    const target = { id: account.id, username: account.username };
                    const statusPending =
                      statusMutation.isPending && statusMutation.variables?.id === account.id;
                    const deletePending =
                      deleteMutation.isPending && deleteMutation.variables?.id === account.id;
                    return (
                      <tr key={account.id}>
                        <td>
                          <div className="account-cell">
                            <span className="avatar-small">
                              <UserCheck size={16} />
                            </span>
                            <strong>{account.username}</strong>
                          </div>
                        </td>
                        <td>
                          <Badge tone={account.status === "enabled" ? "success" : "danger"}>
                            {account.status === "enabled" ? "正常" : "已禁用"}
                          </Badge>
                        </td>
                        <td>
                          <Badge tone={account.online ? "info" : "neutral"}>
                            {account.online ? "在线" : "离线"}
                          </Badge>
                        </td>
                        <td>{formatDateTime(account.createdAt)}</td>
                        <td>{formatDateTime(account.updatedAt)}</td>
                        <td>
                          <div className="table-actions">
                            <IconButton
                              disabled={accountActionPending}
                              icon={<KeyRound size={17} />}
                              label={`重置 ${account.username} 的密码`}
                              onClick={() => openPasswordReset(target)}
                            />
                            <IconButton
                              disabled={accountActionPending}
                              icon={<Ban size={17} />}
                              label={
                                statusPending
                                  ? "正在更新账号状态"
                                  : account.status === "enabled"
                                    ? "禁用账号"
                                    : "启用账号"
                              }
                              onClick={() => {
                                clearFeedback();
                                statusMutation.mutate({
                                  ...target,
                                  status: account.status === "enabled" ? "disabled" : "enabled",
                                });
                              }}
                            />
                            <IconButton
                              disabled={account.online || accountActionPending}
                              icon={<Trash2 size={17} />}
                              label={
                                account.online
                                  ? "账号在线，不能删除"
                                  : deletePending
                                    ? "正在删除账号"
                                    : "删除账号"
                              }
                              onClick={() => deleteAccount(target)}
                              tone="danger"
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div className="section-heading" aria-label="账号分页">
            <span>
              共 {data.pagination.total} 个账号，第 {data.pagination.page} / {totalPages} 页
            </span>
            <div className="table-actions">
              <Button
                disabled={page <= 1 || accountsQuery.isFetching}
                onClick={() => setPage((current) => current - 1)}
                variant="secondary"
              >
                上一页
              </Button>
              <Button
                disabled={page >= totalPages || accountsQuery.isFetching}
                onClick={() => setPage((current) => current + 1)}
                variant="secondary"
              >
                下一页
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
