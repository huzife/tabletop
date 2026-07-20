import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, TextField } from "@tabletop/ui";
import { Gamepad2, Power, Save, Server, TriangleAlert } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { adminApi, ApiClientError } from "../../api/client";

export function ServicesPage() {
  const queryClient = useQueryClient();
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");

  const servicesQuery = useQuery({
    queryFn: () => adminApi.services(),
    queryKey: ["admin", "services"],
  });

  useEffect(() => {
    if (servicesQuery.data) {
      setMaintenanceMessage(servicesQuery.data.site.maintenanceMessage);
    }
  }, [servicesQuery.data]);

  const refreshServices = () => queryClient.invalidateQueries({ queryKey: ["admin", "services"] });

  const siteMutation = useMutation({
    mutationFn: (input: { enabled: boolean; maintenanceMessage: string }) =>
      adminApi.updateSite(input.enabled, input.maintenanceMessage),
    onSuccess: async ({ site }) => {
      setMaintenanceMessage(site.maintenanceMessage);
      setNotice(site.enabled ? "全站服务已开启" : "全站服务已关闭，现有房间已立即终止");
      await refreshServices();
    },
    onError: (cause) => setActionError(errorMessage(cause, "全站服务更新失败")),
  });

  const gameMutation = useMutation({
    mutationFn: (input: { enabled: boolean; gameId: string; name: string }) =>
      adminApi.updateGame(input.gameId, input.enabled),
    onSuccess: async ({ game }) => {
      setNotice(
        game.enabled
          ? `${game.displayName} 服务已开启`
          : `${game.displayName} 服务已关闭，相关房间已立即终止`,
      );
      await refreshServices();
    },
    onError: (cause) => setActionError(errorMessage(cause, "游戏服务更新失败")),
  });

  function updateSite(enabled: boolean) {
    const message = maintenanceMessage.trim();
    if (!message) {
      setActionError("维护提示不能为空");
      return;
    }
    clearFeedback();
    siteMutation.mutate({ enabled, maintenanceMessage: message });
  }

  function saveMaintenanceMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const site = servicesQuery.data?.site;
    if (!site) return;
    updateSite(site.enabled);
  }

  function clearFeedback() {
    setActionError("");
    setNotice("");
  }

  const services = servicesQuery.data;
  const mutationPending = siteMutation.isPending || gameMutation.isPending;

  return (
    <section aria-labelledby="services-title" className="admin-section">
      <div className="section-heading">
        <div>
          <h2 id="services-title">游戏服务</h2>
          <p>关闭服务会立即终止受影响的房间，重新开启后不会恢复对局。</p>
        </div>
        <Power size={21} />
      </div>

      {notice ? (
        <div className="inline-status" role="status">
          {notice}
        </div>
      ) : null}
      {actionError ? (
        <div className="warning-notice" role="alert">
          <TriangleAlert size={18} /> {actionError}
        </div>
      ) : null}
      {servicesQuery.isPending ? (
        <div className="inline-status" role="status">
          正在加载服务状态
        </div>
      ) : null}
      {servicesQuery.isError ? (
        <div className="warning-notice" role="alert">
          <TriangleAlert size={18} /> {errorMessage(servicesQuery.error, "服务状态加载失败")}
        </div>
      ) : null}

      {services ? (
        <>
          <div className="service-list">
            <div className="service-row">
              <span className="service-row__icon">
                <Server size={20} />
              </span>
              <div className="service-row__body">
                <div>
                  <strong>全站服务</strong>
                  <Badge tone={services.site.enabled ? "success" : "danger"}>
                    {services.site.enabled ? "运行中" : "已关闭"}
                  </Badge>
                </div>
                <span>最近更新 {formatDateTime(services.site.updatedAt)}</span>
              </div>
              <label className="switch-control">
                <span className="sr-only">{services.site.enabled ? "关闭" : "开启"}全站服务</span>
                <input
                  checked={services.site.enabled}
                  disabled={mutationPending}
                  onChange={() => updateSite(!services.site.enabled)}
                  role="switch"
                  type="checkbox"
                />
                <span aria-hidden="true" />
              </label>
            </div>

            {services.games.map((game) => {
              const updating =
                gameMutation.isPending && gameMutation.variables?.gameId === game.gameId;
              return (
                <div className="service-row" key={game.gameId}>
                  <span className="service-row__icon">
                    <Gamepad2 size={20} />
                  </span>
                  <div className="service-row__body">
                    <div>
                      <strong>{game.displayName}</strong>
                      <Badge tone={game.enabled ? "success" : "danger"}>
                        {updating ? "更新中" : game.enabled ? "运行中" : "已关闭"}
                      </Badge>
                    </div>
                    <span>单游戏服务 · 最近更新 {formatDateTime(game.updatedAt)}</span>
                  </div>
                  <label className="switch-control">
                    <span className="sr-only">
                      {game.enabled ? "关闭" : "开启"}
                      {game.displayName}
                    </span>
                    <input
                      checked={game.enabled}
                      disabled={mutationPending}
                      onChange={() => {
                        clearFeedback();
                        gameMutation.mutate({
                          enabled: !game.enabled,
                          gameId: game.gameId,
                          name: game.displayName,
                        });
                      }}
                      role="switch"
                      type="checkbox"
                    />
                    <span aria-hidden="true" />
                  </label>
                </div>
              );
            })}
          </div>

          <form className="inline-form" onSubmit={saveMaintenanceMessage}>
            <TextField
              disabled={siteMutation.isPending}
              label="全站关闭提示"
              maxLength={200}
              onChange={(event) => setMaintenanceMessage(event.target.value)}
              required
              value={maintenanceMessage}
            />
            <div className="service-row__body">
              <strong>维护提示</strong>
              <span>全站关闭时，普通用户访问接口会看到此消息。</span>
            </div>
            <div className="inline-form__actions">
              <Button
                disabled={
                  siteMutation.isPending ||
                  !maintenanceMessage.trim() ||
                  maintenanceMessage.trim() === services.site.maintenanceMessage
                }
                type="submit"
                variant="secondary"
              >
                <Save size={17} /> {siteMutation.isPending ? "正在保存" : "保存提示"}
              </Button>
            </div>
          </form>
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
