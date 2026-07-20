#!/usr/bin/env python3
"""Generate the structural SVG diagrams referenced by the design documents."""

from pathlib import Path
from xml.sax.saxutils import escape


ROOT = Path(__file__).resolve().parents[1]
DOC_IMAGES = ROOT / "images"
GAME_IMAGES = ROOT / "games" / "images"

INK = "#1F2A37"
SUB = "#5B6B7B"
LINE = "#5A6675"
BLUE = ("#DCEAF9", "#2E75B6")
GREEN = ("#E2EFDA", "#538135")
ORANGE = ("#FCE4D6", "#C55A11")
PURPLE = ("#E9E3F4", "#73559A")
YELLOW = ("#FFF0B3", "#B88700")
GRAY = ("#F2F3F5", "#8A93A0")
RED = ("#F8DDDD", "#B54A4A")


class Canvas:
    def __init__(self, width: int, height: int, title: str):
        self.width = width
        self.height = height
        self.title = title
        self.parts: list[str] = []

    def rect(self, x, y, w, h, fill, stroke, rx=8, width=1.6, dash=None):
        dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="{width}"{dash_attr}/>'
        )

    def text(self, x, y, value, size=14, anchor="middle", bold=False, color=INK):
        weight = ' font-weight="700"' if bold else ""
        self.parts.append(
            f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="{size}"'
            f'{weight} fill="{color}">{escape(str(value))}</text>'
        )

    def multiline(self, x, y, lines, size=13, bold_first=False, line_height=20, anchor="middle"):
        for index, line in enumerate(lines):
            self.text(
                x,
                y + index * line_height,
                line,
                size=size,
                anchor=anchor,
                bold=bold_first and index == 0,
                color=INK if index == 0 else SUB,
            )

    def box(self, x, y, w, h, lines, palette=GRAY, size=13, bold_first=True, dash=None):
        self.rect(x, y, w, h, palette[0], palette[1], dash=dash)
        total = (len(lines) - 1) * 20
        start = y + h / 2 - total / 2 + 5
        self.multiline(x + w / 2, start, lines, size=size, bold_first=bold_first)

    def line(self, x1, y1, x2, y2, arrow=True, color=LINE, width=1.8, dash=None):
        marker = ' marker-end="url(#arrow)"' if arrow else ""
        dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(
            f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" '
            f'stroke-width="{width}"{marker}{dash_attr}/>'
        )

    def path(self, points, arrow=True, color=LINE, width=1.8, dash=None):
        marker = ' marker-end="url(#arrow)"' if arrow else ""
        dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
        data = " ".join(f"{x},{y}" for x, y in points)
        self.parts.append(
            f'<polyline points="{data}" fill="none" stroke="{color}" stroke-width="{width}"'
            f'{marker}{dash_attr}/>'
        )

    def save(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        body = "".join(self.parts)
        svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}"
 viewBox="0 0 {self.width} {self.height}" font-family="WenQuanYi Micro Hei, Microsoft YaHei, sans-serif">
<defs>
  <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
    <path d="M0,0 L8,3 L0,6 z" fill="{LINE}"/>
  </marker>
</defs>
<rect x="0" y="0" width="{self.width}" height="{self.height}" fill="#FFFFFF"/>
<text x="{self.width / 2}" y="30" text-anchor="middle" font-size="18" font-weight="700" fill="{INK}">{escape(self.title)}</text>
{body}
</svg>'''
        path.write_text(svg, encoding="utf-8")


def architecture():
    c = Canvas(1200, 760, "Tabletop 总体分层架构")
    c.rect(30, 55, 1140, 120, "#F5F9FD", BLUE[1], rx=8)
    c.text(50, 78, "浏览器", size=14, anchor="start", bold=True, color=BLUE[1])
    c.box(65, 95, 245, 58, ["公共应用外壳", "登录 / 首页 / 房间 / 聊天"], BLUE, size=12)
    c.box(340, 95, 245, 58, ["游戏 Web 插件", "棋盘 / 设置 / 动画"], GREEN, size=12)
    c.box(615, 95, 220, 58, ["房间状态 Store", "完整投影快照"], PURPLE, size=12)
    c.box(865, 95, 245, 58, ["HTTP + 房间连接客户端", "WS / 长轮询 / Cookie"], ORANGE, size=12)

    c.box(450, 210, 300, 62, ["Nginx", "静态资源 / API / WS"], GRAY, size=13)
    c.line(987, 175, 750, 210)

    c.rect(30, 315, 1140, 290, "#FBFCFD", "#7A8795", rx=8)
    c.text(50, 340, "Node.js / Fastify 服务", size=14, anchor="start", bold=True)
    c.box(65, 365, 205, 70, ["HTTP API", "认证 / 目录 / 后台"], BLUE)
    c.box(295, 365, 205, 70, ["房间连接网关", "WS / 长轮询 / 路由"], BLUE)
    c.box(525, 365, 250, 70, ["Room Registry + Queue", "内存房间 / 串行命令"], PURPLE)
    c.box(800, 365, 205, 70, ["Game Host", "生命周期 / 投影"], GREEN)
    c.box(1025, 365, 110, 70, ["审计", "日志"], GRAY, size=12)

    c.box(135, 490, 235, 70, ["Deadline Scheduler", "计时 / 协商 / 重连"], YELLOW)
    c.box(435, 490, 210, 70, ["AI Worker", "限时搜索 / 合法动作"], ORANGE)
    c.box(710, 480, 390, 90, ["游戏 Server 插件", "规则 / 状态迁移 / 视图投影 / 可选 AI"], GREEN)

    c.line(520, 272, 165, 365)
    c.line(600, 272, 397, 365)
    c.line(270, 400, 525, 400)
    c.line(500, 400, 525, 400)
    c.line(775, 400, 800, 400)
    c.line(1005, 400, 1025, 400)
    c.line(650, 435, 370, 510)
    c.line(650, 435, 540, 490)
    c.line(905, 435, 905, 480)
    c.line(645, 525, 710, 525)

    c.box(120, 655, 265, 62, ["SQLite WAL", "账号 / 会话 / 开关 / 审计"], ORANGE)
    c.box(465, 655, 265, 62, ["进程内存", "房间 / 游戏状态 / 聊天"], PURPLE)
    c.box(810, 655, 265, 62, ["systemd + journald", "进程 / 健康 / 结构化日志"], GRAY)
    c.line(165, 435, 250, 655)
    c.line(650, 435, 598, 655)
    c.line(1080, 435, 942, 655)
    c.save(DOC_IMAGES / "architecture-fig01.svg")


def plugin_boundary():
    c = Canvas(1120, 650, "游戏插件组成与依赖边界")
    c.rect(40, 55, 1040, 540, "#FBFCFD", "#7A8795")
    c.text(65, 82, "单个 games/<game-id> 包", size=15, anchor="start", bold=True)

    c.box(335, 105, 450, 95, ["shared", "manifest / settings / actions / safe view", "浏览器与服务端均可依赖"], YELLOW)
    c.box(90, 270, 400, 130, ["server", "权威状态 / 规则 / 截止任务", "projectView / 可选 AI", "不得依赖 React 或传输层"], GREEN)
    c.box(630, 270, 400, 130, ["web", "设置编辑器 / 游戏界面", "输入预检 / 展示事件动画", "不得导入权威状态或 AI"], BLUE)

    c.box(90, 475, 400, 85, ["平台服务端", "Room Queue / Game Host / Scheduler"], PURPLE)
    c.box(630, 475, 400, 85, ["浏览器公共外壳", "路由 / 房间 Store / 动作发送器"], ORANGE)

    c.line(290, 270, 430, 200)
    c.line(830, 270, 690, 200)
    c.line(290, 475, 290, 400)
    c.line(830, 475, 830, 400)
    c.path([(490, 520), (560, 520), (560, 335), (630, 335)], arrow=False, dash="6 5")
    c.text(560, 505, "只经协议 DTO 通信", size=12, color=SUB)
    c.text(560, 620, "禁止游戏间依赖；平台调用插件，插件不反向访问全局房间或数据库", size=13, color=SUB)
    c.save(DOC_IMAGES / "plugin-fig01.svg")


def data_model():
    c = Canvas(1180, 690, "SQLite 持久化实体关系")

    def table(x, y, w, title, fields, palette):
        height = 48 + len(fields) * 25
        c.rect(x, y, w, height, "#FFFFFF", palette[1], rx=6)
        c.rect(x, y, w, 38, palette[0], palette[1], rx=6)
        c.text(x + 14, y + 25, title, size=14, anchor="start", bold=True)
        for index, field in enumerate(fields):
            yy = y + 60 + index * 25
            c.text(x + 14, yy, field, size=11, anchor="start", color=INK if index == 0 else SUB)
        return height

    table(60, 85, 300, "accounts", ["PK id", "UQ username_normalized", "password_hash", "role / status", "created_at / updated_at"], BLUE)
    table(60, 360, 300, "sessions", ["PK id", "FK account_id", "UQ token_hash", "csrf_secret_hash", "expires_at / revoked_at"], GREEN)
    table(440, 85, 300, "site_settings", ["PK singleton_id = 1", "enabled", "maintenance_message", "FK updated_by", "updated_at"], ORANGE)
    table(820, 85, 300, "game_service_settings", ["PK game_id", "enabled", "FK updated_by", "updated_at"], YELLOW)
    table(440, 385, 680, "audit_logs", ["PK id / created_at", "FK actor_account_id (nullable) + actor_username snapshot", "action / target_type / target_id / target_label", "result / source_ip / request_id / metadata_json"], PURPLE)

    c.line(210, 262, 210, 360)
    c.text(225, 320, "1 对多，账号删除级联会话", size=11, anchor="start", color=SUB)
    c.path([(360, 170), (400, 170), (400, 150), (440, 150)], color=LINE)
    c.path([(360, 190), (780, 190), (780, 150), (820, 150)], color=LINE)
    c.path([(360, 220), (395, 220), (395, 455), (440, 455)], color=LINE)
    c.text(590, 650, "房间、对局、聊天、邀请令牌和房间密码不进入 SQLite", size=14, bold=True, color=RED[1])
    c.save(DOC_IMAGES / "data-fig01.svg")


def deployment():
    c = Canvas(1160, 650, "Tabletop 单机部署拓扑")
    c.box(55, 210, 210, 90, ["Chrome / Edge", "公网 IP HTTP :80"], BLUE)
    c.box(355, 190, 240, 130, ["Nginx", "静态文件", "/api + 长轮询", "/ws Upgrade"], GRAY)
    c.box(700, 175, 300, 160, ["tabletop.service", "Node.js 22 + Fastify", "127.0.0.1:3000", "User=tabletop", "房间状态在内存"], GREEN)
    c.line(265, 255, 355, 255)
    c.line(595, 235, 700, 235)
    c.text(647, 220, "HTTP API / 长轮询", size=11, color=SUB)
    c.line(595, 285, 700, 285)
    c.text(647, 306, "WebSocket", size=11, color=SUB)

    c.box(80, 430, 250, 90, ["/opt/tabletop/current", "静态资源 + 服务端构建"], PURPLE)
    c.box(425, 430, 250, 90, ["/var/lib/tabletop", "SQLite WAL 数据库"], ORANGE)
    c.box(770, 430, 250, 90, ["/var/backups/tabletop", "每日在线备份 / 保留 30 天"], YELLOW)
    c.line(475, 320, 205, 430)
    c.line(850, 335, 550, 430)
    c.line(675, 475, 770, 475)
    c.text(723, 460, "每日在线备份", size=11, color=SUB)

    c.box(395, 565, 370, 55, ["root 手动部署；systemd 降权运行；UFW 仅开放 22 / 80"], RED, size=12)
    c.save(DOC_IMAGES / "deployment-fig01.svg")


def gomoku_pipeline():
    c = Canvas(1260, 620, "五子棋落子验证与胜负判定管线")
    boxes = [
        (45, 80, 190, 70, ["接收 place", "坐标 + revision"], BLUE),
        (275, 80, 190, 70, ["公共校验", "身份 / 回合 / 空点"], GRAY),
        (505, 80, 200, 70, ["连珠黑方？", "正式禁手评估"], PURPLE),
        (745, 80, 190, 70, ["结算棋钟", "超时则判负"], YELLOW),
        (975, 80, 225, 70, ["暂存棋子", "扫描四条轴"], GREEN),
    ]
    for x, y, w, h, lines, palette in boxes:
        c.box(x, y, w, h, lines, palette, size=12)
    for left, right in zip(boxes, boxes[1:]):
        c.line(left[0] + left[2], 115, right[0], 115)

    c.box(505, 225, 200, 70, ["禁手", "拒绝且状态不变"], RED)
    c.line(605, 150, 605, 225)
    c.text(620, 192, "非法", size=11, anchor="start", color=RED[1])

    c.box(80, 390, 230, 80, ["自由规则", "连续数 >= 5 即胜"], BLUE)
    c.box(385, 390, 230, 80, ["标准规则", "连续数 == 5 即胜"], ORANGE)
    c.box(690, 390, 230, 80, ["连珠规则", "黑恰好五 / 白 >= 5"], PURPLE)
    c.box(995, 390, 200, 80, ["无胜者", "满盘和棋或换手"], GREEN)
    c.line(1088, 150, 1088, 330, arrow=False)
    c.line(195, 330, 1095, 330, arrow=False)
    c.text(965, 316, "按房间规则选择判定器", size=11, color=SUB)
    c.line(195, 330, 195, 390)
    c.line(500, 330, 500, 390)
    c.line(805, 330, 805, 390)
    c.line(1095, 330, 1095, 390)
    c.box(420, 530, 420, 55, ["提交新状态 → revision + 1 → 为玩家和观众生成投影"], GREEN, size=12)
    c.line(195, 470, 500, 530)
    c.line(500, 470, 565, 530)
    c.line(805, 470, 695, 530)
    c.line(1095, 470, 760, 530)
    c.save(GAME_IMAGES / "gomoku-fig02.svg")


def ludo_topology():
    c = Canvas(1160, 760, "飞行棋逻辑棋盘拓扑")
    c.rect(360, 220, 440, 310, "#F7F8FA", "#5A6675", rx=150, width=3)
    c.text(580, 365, "公共环道 MAIN_PATH", size=18, bold=True)
    c.text(580, 395, "四种颜色以独立入口和方向映射到共享逻辑格", size=12, color=SUB)

    # Top launch lanes.
    c.box(40, 70, 125, 55, ["红方 BASE"], RED, size=12)
    c.box(205, 70, 130, 55, ["APRON", "场外起点格"], RED, size=11)
    c.line(165, 97, 205, 97)
    c.path([(270, 125), (270, 175), (420, 220)], color=RED[1])

    c.box(825, 70, 125, 55, ["黄方 BASE"], YELLOW, size=12)
    c.box(990, 70, 130, 55, ["APRON", "场外起点格"], YELLOW, size=11)
    c.line(950, 97, 990, 97)
    c.path([(1055, 125), (1055, 175), (740, 220)], color=YELLOW[1])

    # Side home lanes leave the shared ring without crossing launch nodes.
    c.box(40, 260, 145, 55, ["红方 HOME_PATH", "专属终点跑道"], RED, size=11)
    c.box(40, 350, 145, 55, ["FINISHED", "抵达后移除"], GRAY, size=11)
    c.line(360, 287, 185, 287)
    c.line(112, 315, 112, 350)

    c.box(975, 260, 145, 55, ["黄方 HOME_PATH", "专属终点跑道"], YELLOW, size=11)
    c.box(975, 350, 145, 55, ["FINISHED", "抵达后移除"], GRAY, size=11)
    c.line(800, 287, 975, 287)
    c.line(1047, 315, 1047, 350)

    c.box(40, 440, 145, 55, ["蓝方 HOME_PATH", "专属终点跑道"], BLUE, size=11)
    c.box(40, 530, 145, 55, ["FINISHED", "抵达后移除"], GRAY, size=11)
    c.line(360, 467, 185, 467)
    c.line(112, 495, 112, 530)

    c.box(975, 440, 145, 55, ["绿方 HOME_PATH", "专属终点跑道"], GREEN, size=11)
    c.box(975, 530, 145, 55, ["FINISHED", "抵达后移除"], GRAY, size=11)
    c.line(800, 467, 975, 467)
    c.line(1047, 495, 1047, 530)

    # Bottom launch lanes.
    c.box(40, 625, 125, 55, ["蓝方 BASE"], BLUE, size=12)
    c.box(205, 625, 130, 55, ["APRON", "场外起点格"], BLUE, size=11)
    c.line(165, 652, 205, 652)
    c.path([(270, 625), (270, 580), (420, 530)], color=BLUE[1])

    c.box(825, 625, 125, 55, ["绿方 BASE"], GREEN, size=12)
    c.box(990, 625, 130, 55, ["APRON", "场外起点格"], GREEN, size=11)
    c.line(950, 652, 990, 652)
    c.path([(1055, 625), (1055, 600), (900, 600), (900, 580), (740, 530)], color=GREEN[1])

    c.text(580, 730, "跳跃格与快捷飞行入口/出口是环道静态元数据；图片坐标不参与服务端规则", size=13, bold=True, color=PURPLE[1])
    c.save(GAME_IMAGES / "ludo-fig01.svg")


if __name__ == "__main__":
    architecture()
    plugin_boundary()
    data_model()
    deployment()
    gomoku_pipeline()
    ludo_topology()
    print("Generated 6 structural SVG diagrams")
