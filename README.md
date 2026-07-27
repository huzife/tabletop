# Tabletop

Tabletop 是一个面向熟人朋友的网页桌游平台。平台提供账号、游戏目录、房间、实时联机、观战、聊天、管理开关和游戏插件基础设施；当前已接入五子棋、飞行棋和台球。

项目当前处于实现阶段。`develop` 用于日常开发和集成，经过验证的稳定内容才进入 `master`。

## 文档索引

- [需求规格说明](docs/requirements.md)
- [总体架构设计](docs/architecture.md)
- [游戏插件扩展指南](docs/game-plugin-guide.md)
- [2D 场景与碰撞区编辑器](docs/scene-editor.md)
- [接口与实时协议](docs/protocol.md)
- [数据模型设计](docs/data-model.md)
- [部署与运维设计](docs/deployment.md)
- [管理后台与日常运维](docs/operations.md)
- [游戏设计总览](docs/games/README.md)

## 首期边界

- 浏览器：桌面版 Chrome、Edge，最低可用窗口为 1280x720。
- 部署：单台受支持的 Linux 云服务器，不使用 Docker。
- 数据：SQLite 仅持久化账号、会话、服务开关和审计日志。
- 对局：运行在内存中，服务器重启后允许丢失，不保存历史战绩或回放。
- 扩展：游戏由核心开发者以 TypeScript 代码模块接入，随网站一同构建和部署。

## 开发

项目使用 Node.js 22 和仓库 `packageManager` 字段指定的 pnpm 版本：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

游戏界面、矢量图形和碰撞区可以在独立的本地编辑器中绘制并导出为游戏可加载的 JSON：

```bash
pnpm dev:scene
```

提交前执行：

```bash
pnpm check
pnpm build
```

本地服务启动并准备好管理员测试账号后，可重复执行 1280x720 与 1920x1080 的 Chromium 视觉烟测。账号密码只通过当前命令环境传入，不写入仓库：

```bash
TABLETOP_E2E_USERNAME=<测试账号> \
TABLETOP_E2E_PASSWORD=<测试密码> \
pnpm test:visual
```

CI 或精简开发机可额外设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 与 `TABLETOP_E2E_VIEWPORT`；脚本会检查首页、后台、两款练习对局的溢出、重叠、控件裁切、浏览器错误和棋盘比例。

## 部署

生产目标是单台受支持的 Linux 云服务器。root 手工执行 provision 和发布脚本，Node.js 服务以专用低权限用户运行；Nginx 提供静态页面并代理 HTTP API、长轮询与 WebSocket，SQLite 每日在线备份并保留 30 天。

```bash
bash scripts/provision-server.sh
bash scripts/deploy.sh                 # origin/master
bash scripts/deploy.sh --branch develop
```

首次部署、私有仓库凭据、环境变量、管理员初始化、备份恢复和故障处理步骤见[部署与运维](docs/deployment.md)。仓库内的环境模板不包含真实秘密；不要提交 `/etc/tabletop/tabletop.env`、数据库、备份、证书或 SSH 私钥。
