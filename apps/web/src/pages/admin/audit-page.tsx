import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge, Button, TextField } from "@tabletop/ui";
import { Download, FileClock, Search } from "lucide-react";
import { useState, type FormEvent } from "react";

import { adminApi, ApiClientError } from "../../api/client";

const PAGE_SIZE = 20;
const ACCOUNT_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const knownActions = [
  "auth.login",
  "account.create",
  "account.status.change",
  "account.password.reset",
  "account.password.change",
  "account.delete",
  "service.site.update",
  "service.game.update",
  "audit.export",
] as const;

type AuditResultFilter = "all" | "failure" | "success";

interface AuditFilters {
  readonly accountId: string;
  readonly action: string;
  readonly from: string;
  readonly result: AuditResultFilter;
  readonly to: string;
}

const initialFilters: AuditFilters = {
  accountId: "",
  action: "",
  from: "",
  result: "all",
  to: "",
};

export function AuditPage() {
  const [page, setPage] = useState(1);
  const [draftFilters, setDraftFilters] = useState<AuditFilters>(initialFilters);
  const [filters, setFilters] = useState<AuditFilters>(initialFilters);
  const [filterError, setFilterError] = useState("");
  const [downloadError, setDownloadError] = useState("");

  const auditQuery = useQuery({
    queryFn: () => adminApi.audit({ page, pageSize: PAGE_SIZE, ...apiFilters(filters) }),
    queryKey: ["admin", "audit", page, filters],
  });

  const downloadMutation = useMutation({
    mutationFn: () => adminApi.downloadAuditCsv(apiFilters(filters)),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `tabletop-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    },
    onError: (cause) => setDownloadError(errorMessage(cause, "审计日志导出失败")),
  });

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accountId = draftFilters.accountId.trim().toUpperCase();
    const action = draftFilters.action.trim();
    if (accountId && !ACCOUNT_ID_PATTERN.test(accountId)) {
      setFilterError("账号 ID 必须是 26 位 ULID");
      return;
    }
    if (draftFilters.from && draftFilters.to) {
      if (Date.parse(draftFilters.from) >= Date.parse(draftFilters.to)) {
        setFilterError("结束时间必须晚于开始时间");
        return;
      }
    }
    setFilterError("");
    setDownloadError("");
    setFilters({ ...draftFilters, accountId, action });
    setPage(1);
  }

  function exportCsv() {
    setDownloadError("");
    downloadMutation.mutate();
  }

  const data = auditQuery.data;
  const totalPages = Math.max(1, Math.ceil((data?.pagination.total ?? 0) / PAGE_SIZE));

  return (
    <section aria-labelledby="audit-title" className="admin-section">
      <div className="section-heading">
        <div>
          <h2 id="audit-title">审计日志</h2>
          <p>后台操作日志保留 30 天，可按账号、操作、结果和时间范围筛选。</p>
        </div>
        <Button
          disabled={downloadMutation.isPending || auditQuery.isPending}
          onClick={exportCsv}
          variant="secondary"
        >
          <Download size={17} /> {downloadMutation.isPending ? "正在导出" : "导出 CSV"}
        </Button>
      </div>

      {filterError || downloadError ? (
        <div className="warning-notice" role="alert">
          {filterError || downloadError}
        </div>
      ) : null}

      <form className="filter-bar" onSubmit={applyFilters}>
        <TextField
          label="账号 ID"
          maxLength={26}
          onChange={(event) =>
            setDraftFilters((current) => ({ ...current, accountId: event.target.value }))
          }
          placeholder="26 位账号 ID"
          value={draftFilters.accountId}
        />
        <TextField
          label="操作代码"
          list="audit-action-options"
          maxLength={64}
          onChange={(event) =>
            setDraftFilters((current) => ({ ...current, action: event.target.value }))
          }
          placeholder="全部操作"
          value={draftFilters.action}
        />
        <datalist id="audit-action-options">
          {knownActions.map((action) => (
            <option key={action} value={action} />
          ))}
        </datalist>
        <label className="select-field">
          <span>执行结果</span>
          <select
            onChange={(event) =>
              setDraftFilters((current) => ({
                ...current,
                result: event.target.value as AuditResultFilter,
              }))
            }
            value={draftFilters.result}
          >
            <option value="all">全部结果</option>
            <option value="success">成功</option>
            <option value="failure">失败</option>
          </select>
        </label>
        <TextField
          label="开始时间"
          onChange={(event) =>
            setDraftFilters((current) => ({ ...current, from: event.target.value }))
          }
          type="datetime-local"
          value={draftFilters.from}
        />
        <TextField
          label="结束时间"
          onChange={(event) =>
            setDraftFilters((current) => ({ ...current, to: event.target.value }))
          }
          type="datetime-local"
          value={draftFilters.to}
        />
        <Button disabled={auditQuery.isFetching} type="submit" variant="secondary">
          <Search size={17} /> {auditQuery.isFetching ? "正在检索" : "检索"}
        </Button>
      </form>

      {auditQuery.isPending ? (
        <div className="inline-status" role="status">
          正在加载审计日志
        </div>
      ) : null}
      {auditQuery.isError ? (
        <div className="warning-notice" role="alert">
          {errorMessage(auditQuery.error, "审计日志加载失败")}
        </div>
      ) : null}

      {data ? (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作者</th>
                  <th>操作</th>
                  <th>目标</th>
                  <th>结果</th>
                  <th>来源 IP</th>
                </tr>
              </thead>
              <tbody>
                {data.logs.length === 0 ? (
                  <tr>
                    <td colSpan={6}>没有符合条件的审计记录</td>
                  </tr>
                ) : (
                  data.logs.map((entry) => (
                    <tr key={entry.id}>
                      <td>{formatDateTime(entry.createdAt)}</td>
                      <td>
                        <div className="service-row__body">
                          <strong>{entry.actorUsername}</strong>
                          <span>{entry.actorAccountId ?? "系统"}</span>
                        </div>
                      </td>
                      <td>
                        <span className="audit-action" title={entry.action}>
                          <FileClock size={15} /> {actionLabel(entry.action)}
                        </span>
                      </td>
                      <td>
                        <div className="service-row__body">
                          <strong>{entry.targetLabel ?? entry.targetId ?? "-"}</strong>
                          <span>{entry.targetType}</span>
                        </div>
                      </td>
                      <td>
                        <Badge tone={entry.result === "success" ? "success" : "danger"}>
                          {entry.result === "success" ? "成功" : "失败"}
                        </Badge>
                      </td>
                      <td>{entry.sourceIp ?? "-"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="section-heading" aria-label="审计日志分页">
            <span>
              共 {data.pagination.total} 条记录，第 {data.pagination.page} / {totalPages} 页
            </span>
            <div className="table-actions">
              <Button
                disabled={page <= 1 || auditQuery.isFetching}
                onClick={() => setPage((current) => current - 1)}
                variant="secondary"
              >
                上一页
              </Button>
              <Button
                disabled={page >= totalPages || auditQuery.isFetching}
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

function apiFilters(filters: AuditFilters) {
  return {
    ...(filters.accountId ? { accountId: filters.accountId } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.from ? { from: new Date(filters.from).toISOString() } : {}),
    ...(filters.result === "all" ? {} : { result: filters.result }),
    ...(filters.to ? { to: new Date(filters.to).toISOString() } : {}),
  };
}

function actionLabel(action: string): string {
  const labels: Readonly<Record<string, string>> = {
    "account.create": "创建账号",
    "account.delete": "删除账号",
    "account.password.change": "用户修改密码",
    "account.password.reset": "管理员重置密码",
    "account.status.change": "修改账号状态",
    "audit.export": "导出审计日志",
    "auth.login": "账号登录",
    "service.game.update": "更新游戏服务",
    "service.site.update": "更新全站服务",
  };
  return labels[action] ?? action;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}
