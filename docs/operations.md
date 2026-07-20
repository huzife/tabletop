# Tabletop 管理后台与日常运维

> 适用版本：`develop` 当前实现
> 权限边界：网页后台由唯一管理员使用；服务器运维命令只能由 root 执行

本文说明已经完成首次部署后的日常操作。首次安装系统依赖、创建服务账号和初始化管理员仍按[部署与运维设计](deployment.md)第 3 节执行；具体游戏规则、设置和操作说明只在 [games/](games/README.md) 下维护，不在本文重复。

## 1. 两种“关闭服务”

Tabletop 有两个不同层面的服务控制，使用前必须先区分影响范围。

| 目标 | 推荐入口 | 对玩家的影响 | 是否停止 Node.js / Nginx | 典型用途 |
| --- | --- | --- | --- | --- |
| 暂停全站游戏 | 网页后台的“全站服务”开关 | 立即终止全部房间；普通用户看到维护提示 | 否 | 正常维护、暂时不让玩家进入 |
| 暂停某一种游戏 | 网页后台的对应游戏开关 | 立即终止该游戏的房间；其他游戏继续可玩 | 否 | 修复或临时下线单个游戏 |
| 停止应用进程 | `operations.sh stop` 或 `systemctl stop tabletop.service` | 内存中的全部房间、聊天和对局都会丢失 | 只停止 Node.js；Nginx 仍运行 | 进程级维护、故障处理 |
| 停止整个网页入口 | `systemctl stop tabletop.service nginx.service` | 页面、API、长轮询和 WebSocket 全部不可用 | 是 | 专用服务器停机维护 |

全站或单游戏开关的状态保存于 SQLite，重启后仍然生效；重新开启也不会恢复已经终止的房间。系统级停止不会给网页显示维护提示，因此在计划维护时，先在后台关闭全站服务，再等待用户离开或确认房间已终止，最后再执行系统级操作。

当前服务器的 Nginx 是部署入口。若未来同一台机器托管其他网站，不要为了关闭 Tabletop 而停止 `nginx.service`，只停止 `tabletop.service` 或使用后台的全站服务开关。

## 2. 管理后台

以管理员账号登录部署入口后，右上角会出现“管理”。进入后有“账号”“服务”“审计”三个标签页；普通账号不会看到该入口，也无法直接访问 `/admin/*` 路由。

后台不提供房间列表、房间详情或对局控制。这是有意的权限边界：房间由玩家和房主处理，管理员只管理账号准入、服务可用性和审计。

### 2.1 账号

“账号”页只列出普通账号，顶部的“新建账号”用于创建玩家账号。填写用户名和初始密码后点击“创建”：

- 用户名长度为 3 至 32 个字符，英文字母不区分大小写；可使用中文、字母、数字、下划线和短横线。
- 密码至少 6 个字符。界面和审计日志不会显示明文密码。
- 用户名已存在时创建会被拒绝。网站没有公开注册入口，所有普通账号都在这里创建。

账号列表支持按用户名和状态检索，每页 20 条。每个普通账号的操作按钮含义如下：

| 操作 | 结果 | 限制与注意事项 |
| --- | --- | --- |
| 重置密码 | 立即设置新密码并注销该账号全部登录会话 | 将同时断开该账号正在使用的设备；把新密码通过可信渠道通知用户 |
| 禁用 / 启用 | 禁用时撤销全部会话并移出房间；启用后可再次登录 | 禁用不删除账号数据 |
| 删除 | 永久删除账号 | 仅离线且未属于任何房间的账号可删除；删除不可撤销 |

唯一管理员不出现在普通账号的可操作列表中，不能由后台禁用、删除或重置。管理员需要改自己的密码时，点击右上角用户名进入“安全设置”，输入当前密码和新密码；修改成功后，其他设备上的管理员会话会被注销。

### 2.2 服务

“服务”页显示全站服务和每个已编译注册游戏的状态。维护提示不能为空，修改提示后点击“保存维护提示”；切换全站开关时也会保存当前提示。

- 关闭“全站服务”：所有房间立即终止，普通用户只看到维护提示；管理员仍可进入后台重新开启。页面、数据库备份和 Nginx 不会停止。
- 关闭某个游戏：该游戏的所有房间立即终止，游戏目录仍显示该游戏为关闭状态；其他游戏和房间不受影响。
- 重新开启：允许新房间和新对局，不会恢复被终止的房间、聊天或局面。

所以，修改规则代码、数据库、Nginx 或系统配置前，应使用“全站服务”开关；仅修复某个游戏时应使用该游戏开关。服务开关会写入审计日志。

### 2.3 审计

“审计”页保留最近 30 天的安全和管理记录。可按账号 ID、操作代码、成功/失败状态以及开始/结束时间检索；点击“导出 CSV”下载当前筛选条件下的所有匹配记录。

常见操作代码包括：

| 代码 | 含义 |
| --- | --- |
| `auth.login` | 登录尝试 |
| `account.create` | 创建普通账号 |
| `account.status.change` | 启用或禁用普通账号 |
| `account.password.reset` | 管理员重置普通账号密码 |
| `account.delete` | 删除普通账号 |
| `account.password.change` | 用户或管理员修改自己的密码 |
| `service.site.update` | 修改全站服务或维护提示 |
| `service.game.update` | 修改单游戏服务开关 |
| `audit.export` | 导出审计 CSV |

审计只用于追踪平台安全和管理动作，不保存房间聊天、对局战绩或回放。超过 30 天的记录由应用定期清理，导出的 CSV 也必须按实际需要妥善保存。

## 3. 更新代码与分支流程

本地开发仓与服务器使用不同的 Git 访问方式。具体远端地址只存在于各自的本地 Git 配置或当前命令环境，不写入仓库：

| 位置 | 远端来源 | 用途 |
| --- | --- | --- |
| 本地开发机 | 本地 Git 配置 | 使用组织批准的协议拉取和推送 |
| 生产服务器 `/opt/tabletop/repository` | 首次发布时通过 `TABLETOP_REPOSITORY_URL` 或 `--repository-url` 提供 | 只使用 HTTPS 拉取，不配置代码托管平台的 SSH 密钥 |

日常开发在 `develop` 进行；完成检查后再合入 `master`。不使用 Pull Request 作为强制步骤，但不要直接在生产服务器修改源码或提交。推荐流程如下：

```bash
# 本地开发机
cd <repository-directory>
git switch develop

# 编辑、测试并确认工作区内容
pnpm check
pnpm build
git status --short
git add <经过检查的文件>
git commit -m "feat: ..."
git push origin develop

# 确认 develop 稳定后，再更新 master
git switch master
git merge --ff-only develop
git push origin master
git switch develop
```

`--ff-only` 会拒绝非线性合并，避免误把未经确认的本地分支历史带入 `master`。如果历史无法快进，应先检查提交关系并明确决定如何整理，而不是用强制推送覆盖远端分支。

服务器只从远端分支读取已推送提交。生产发布默认目标是 `master`；需要验证开发版本时必须显式选择 `develop`。发布会重新安装锁定依赖、运行类型检查和测试、构建、在线备份、迁移数据库并原子切换 release。由于房间和对局只在内存中，发布会终止正在进行的对局。

```bash
# root 登录生产服务器后；正式发布 master
bash /opt/tabletop/current/scripts/operations.sh deploy

# 验证 develop，明确指定分支
bash /opt/tabletop/current/scripts/operations.sh deploy --branch develop

# 发布某个已知稳定提交；该提交必须属于相应远端分支
bash /opt/tabletop/current/scripts/operations.sh deploy \
  --branch master \
  --revision <commit-sha>
```

首次发布前没有 `/opt/tabletop/current`，不能使用上述包装脚本。此时在已通过 HTTPS 获取的 bootstrap 检出目录执行：

```bash
cd /root/tabletop-bootstrap
bash scripts/provision-server.sh
TABLETOP_REPOSITORY_URL='<repository-url>' \
  bash scripts/deploy.sh --branch develop
```

日常发布不需要手动 `git pull`、`pnpm install`、迁移或手动重启；`deploy.sh` 已经执行这些步骤并在失败时尝试恢复先前 release。发布完成后再检查状态和日志，不要在另一个终端同时执行第二次发布或恢复。

如果当前运行的旧 release 尚未包含 `scripts/operations.sh`，第一次升级该脚本时直接调用已有发布脚本即可：

```bash
bash /opt/tabletop/current/scripts/deploy.sh --branch develop
```

该次发布成功后，`/opt/tabletop/current` 会切换到包含 `operations.sh` 的新 release，后续再使用第 4 节的包装命令。

### 3.1 仅更新部署配置

修改 `deploy/nginx/`、`deploy/systemd/`、`deploy/tabletop.env.example` 或 `scripts/provision-server.sh` 后，普通应用发布不会覆盖服务器已安装的 Nginx/systemd 配置。应先把变更提交并推送，再在服务器用包含该提交的 bootstrap 检出目录运行 provision：

```bash
cd /root/tabletop-bootstrap
git pull --ff-only
bash scripts/provision-server.sh
```

`provision-server.sh` 会保留现有 `/etc/tabletop/tabletop.env` 和 `SESSION_SECRET`，但会安装仓库版本的 Nginx 与 systemd unit 并执行 `daemon-reload`。运行后检查 `nginx -t`、`systemctl status tabletop nginx`；如果应用代码也变了，再执行第 3 节的发布命令。

服务器 bootstrap 目录也必须从 HTTPS 获取；不要为了更新配置在服务器配置代码托管平台的 SSH 私钥。私有仓库需要受保护的 HTTPS 凭据机制，不能把令牌写入仓库 URL、shell 历史或本仓库文件。

## 4. 日常运维命令

`scripts/operations.sh` 是对已有发布、备份和恢复脚本的受限包装。首次成功发布后，推荐 root 在服务器上执行它的当前 release 路径：

```bash
TABLETOP_OPS=/opt/tabletop/current/scripts/operations.sh
bash "$TABLETOP_OPS" status
bash "$TABLETOP_OPS" logs
bash "$TABLETOP_OPS" logs backup --lines 100
bash "$TABLETOP_OPS" logs nginx --lines 100
```

`status` 显示当前 release、`tabletop.service`、Nginx、每日备份 timer 以及应用 readiness。`logs` 默认查看 Tabletop 最近 200 行日志；可选择 `tabletop`、`backup` 或 `nginx`，行数范围为 1 至 99999。

### 4.1 启动、停止和重启应用

```bash
# 启动或恢复 Node.js 应用，并等待 readiness
bash "$TABLETOP_OPS" start

# 停止 Node.js 应用；会终止内存中的房间和对局
bash "$TABLETOP_OPS" stop

# 重启 Node.js 应用；会终止内存中的房间和对局
bash "$TABLETOP_OPS" restart
```

这些命令等价于管理 `tabletop.service`，不会停止 Nginx，也不会删除 SQLite 数据、服务开关、账号、会话或审计记录。应用开机自启由 provision 配置；若系统重启后未恢复，先运行 `status` 和 `logs`，不要反复重启掩盖错误。

在专用服务器上确实需要完全关闭网页入口时，使用：

```bash
systemctl stop tabletop.service nginx.service
```

恢复时：

```bash
systemctl start nginx.service tabletop.service
bash "$TABLETOP_OPS" status
```

这两个命令影响整台机器上的 Nginx。只有确认该 Nginx 未承载其他服务时才能使用；常规维护优先使用后台的全站服务开关。

### 4.2 数据库备份与恢复

数据库每天 04:15 自动在线备份，最多增加 15 分钟随机延迟，保留 30 天。手动备份：

```bash
bash "$TABLETOP_OPS" backup
systemctl status tabletop-backup.service --no-pager
find /var/backups/tabletop -maxdepth 1 -type f -name 'tabletop-*.sqlite3' -ls
```

从备份恢复会停止应用，先备份当前数据库，并在迁移或 readiness 失败时尝试自动回放恢复前数据库。先列出候选文件，再执行交互式恢复；不要跳过确认：

```bash
ls -lh /var/backups/tabletop
bash "$TABLETOP_OPS" restore \
  /var/backups/tabletop/tabletop-<UTC时间>-daily.sqlite3
```

恢复后验证管理员登录、账号列表和全站/游戏服务开关。房间、棋局、聊天和战绩不持久化，不能从数据库备份恢复。

## 5. 发布后检查与故障处理

每次发布、重启、恢复或修改服务开关后，按以下顺序确认：

```bash
bash "$TABLETOP_OPS" status
curl --fail http://127.0.0.1:3000/health/ready
curl --fail http://127.0.0.1/api/v1
nginx -t
```

预期 Node.js 只监听 `127.0.0.1:3000`，公网只通过 Nginx 的 `80` 端口进入：

```bash
ss -lntp
ufw status
```

发布失败时，先保存命令输出，再查看：

```bash
bash "$TABLETOP_OPS" logs tabletop --lines 200
bash "$TABLETOP_OPS" logs nginx --lines 100
readlink -f /opt/tabletop/current
cat /opt/tabletop/current/.tabletop-release
df -h
free -h
```

不要手工删除当前或前一个 release，也不要在生产 SQLite 主库上使用 `drizzle-kit push` 或随意执行 SQL。`deploy.sh` 会保留当前和上一个 release，目标提交仍在指定远端分支时，可通过 `deploy --branch <branch> --revision <known-good-commit>` 回到已知稳定版本。

## 6. 当前 HTTP 限制

当前入口为公网 IP 的 HTTP `80`，仅适合阶段性联调。用户名、密码和 Cookie 在传输中没有 TLS 保护。取得域名后，应按[部署与运维设计](deployment.md)第 9 节配置 HTTPS、把 `COOKIE_SECURE` 改为 `true`，并重新验证登录、后台写操作、WebSocket 和长轮询降级。
