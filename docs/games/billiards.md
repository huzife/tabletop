# 台球 Rust/WASM 架构与实现边界

## 1. 范围与状态

台球插件位于 `games/billiards`，提供中式八球、斯诺克双人对局和单人练习。浏览器负责输入和动画，服务端负责权限、回合与最终裁决；客户端不能提交球位、得分、犯规或胜负。

本版本已将原 TypeScript 固定步长物理实现替换为独立 Rust 核心，并把同一份 release WASM 同时用于 Node 服务端和浏览器回放。Rust 核心包含：

- 运动状态、事件预测、碰撞与袋口求解；
- 中式八球、斯诺克和练习模式的纯函数规则 reducer；
- 初始摆球、置球校验和规则决策状态；
- 每杆事件记录、状态哈希和有界轨迹预测。

本文用以下措辞区分能力边界：

- **产品实现**：本仓库 Rust/WASM 核心、TypeScript 框架适配器和协议共同提供的能力。
- **Pooltool 参考**：从 Pooltool 的公开理论、事件驱动架构和几何表达获得的设计参考，不表示源码移植或数值等价。
- **未完整实现**：需要裁判判断、器材标定或更完整三维接触模型的已知边界，不宣称与正式赛事完全一致。

## 2. 与原框架的接入

原有 `GameServerModuleV1` 同步回调、房间快照、共享动作 schema 和临时瞄准事件等框架合同保持兼容。展示事件 schema 只向后兼容地新增可空的物理版本与状态 hash 字段，旧事件仍可解析。WASM 作为插件内部实现细节，不改变平台的同步服务端回调合同。

```mermaid
flowchart LR
    UI[浏览器输入] --> Schema[共享动作 schema]
    Schema --> Adapter[GameServerModuleV1 适配器]
    Adapter --> Node[Node 同步 WASM loader]
    Node --> Core[Rust 核心]
    Core --> Physics[物理与几何]
    Core --> Rules[规则 reducer]
    Core --> Replay[事件、hash、predict]
    Adapter --> Event[权威快照与展示事件]
    Event --> UI
    UI --> Browser[浏览器异步 WASM loader]
    Browser --> Core
```

主要边界如下：

- `games/billiards/native/src` 是 Rust 权威核心。它导出小型 JSON/线性内存 ABI，支持 `ping`、`simulate`、`predict`、`create-match` 和 `reduce-action`，不依赖 Python 或 `wasm-bindgen` 运行时。
- `games/billiards/physics/index.ts` 在 Node 中加载并复用单个 WASM 实例，保留同步 `simulateBilliardsShot` 接口，因此现有服务端模块不需要改成异步。
- `games/billiards/physics/browser.ts` 按需异步获取并缓存同一 WASM，用于展示事件回放和轨迹预测。
- 服务端先运行权威物理，再把不可变的物理摘要交给 Rust 规则 reducer；reducer 返回新的比赛状态，不读取全局状态，也不自行获取随机数。
- 决胜黑球需要掷币时，平台权威随机源先选出座位索引，再把该索引注入 reducer。测试和重放可注入固定索引；断线、离房、展示事件组装和房间完成通知仍属于平台适配层。
- 原 TypeScript 规则实现已移除；在线对局与规则测试都通过 Rust rules ABI，避免两套裁决逻辑产生分叉。

WASM 构建产物使用插件内的稳定相对路径 `games/billiards/native/generated/tabletop_billiards_core.wasm`。打包后会复制到 `dist/native/generated`；不要在代码或文档中写入开发机路径。

## 3. Pooltool 的参考边界

研究基线固定为 Pooltool commit [`9a8abfe`](https://github.com/ekiefl/pooltool/tree/9a8abfe)，避免上游后续演进改变本文所指的行为。Pooltool 的 [JOSS 论文](https://joss.theoj.org/papers/10.21105/joss.07301)将其定位为面向科研与工程的通用 Python 台球模拟器；其事件驱动算法会解析下一次碰撞或运动状态变化并直接演化到该时刻。

产品主要参考了：

- [算法博客](https://ekiefl.github.io/2020/12/20/pooltool-alg/)中的连续事件驱动循环；
- [物理 theory 系列](https://ekiefl.github.io/2020/04/24/pooltool-theory/)中的静止、自转、滑动、滚动和腾空分段模型；
- 固定版本的[事件循环](https://github.com/ekiefl/pooltool/blob/9a8abfe/pooltool/evolution/event_based/simulate.py)、[运动演化](https://github.com/ekiefl/pooltool/blob/9a8abfe/pooltool/physics/evolve/__init__.py)、[球球碰撞时间](https://github.com/ekiefl/pooltool/blob/9a8abfe/pooltool/evolution/event_based/detect/ball_ball.py)和[球桌布局](https://github.com/ekiefl/pooltool/blob/9a8abfe/pooltool/objects/table/layout.py)；
- Pooltool [官方文档](https://pooltool.readthedocs.io/en/stable/)对事件、物体和可替换物理策略的组织方式。

以下内容不是从 Pooltool 获得的完整产品方案：

| 领域 | 固定 Pooltool 版本的边界 | 本产品的处理 |
| --- | --- | --- |
| 同时事件 | 事件循环选择并解析单个下一事件，不是联合多接触约束求解器 | 把同一最早时间容差桶中的球球/球库接触合并，固定顺序运行固定轮数 PGS |
| 比赛规则 | 上游 [ruleset](https://github.com/ekiefl/pooltool/tree/9a8abfe/pooltool/ruleset) 中的 `eight_ball` 是通用八球规则，不是 WPA Heyball profile；Snooker ruleset 不完整覆盖推杆、跳球、miss、离台和完整裁判流程 | 独立 Rust profile 按本产品明确范围处理回合、犯规、计分、摆球和决策 |
| 击球 | 上游提供[瞬时点接触等可替换模型](https://pooltool.readthedocs.io/en/stable/resources/custom_physics.html)，但不是本产品的输入协议或滑杆裁决合同 | 定义稳定的方向、力度、击球点、仰角输入和 `miscue`/squirt 诊断 |
| 产品确定性 | 科研模拟 API 不等于房间协议、跨端回放或联网校验方案 | 同一 WASM、稳定排序、量化、版本号、兼容 checksum 和状态 hash |
| AI | 模拟可作为 AI/机器人研究环境，但不提供本产品的 bot 策略 | 暴露有界 `predict` 原语；搜索、选杆和风险策略仍由上层实现 |

因此，本实现不是 Pooltool 的 Rust 端口，不加载 Pooltool Python 包，也不承诺与 Pooltool 逐事件或逐浮点数一致。固定上游版本对同时接触、赛事规则、滑杆裁决和联网状态哈希没有给出可直接接入本框架的完整答案；这些是本仓库的产品实现。

## 4. 规则 profile

规则权威来源是 [WPA 2025 Rules of Heyball](https://wpapool.com/wp-content/uploads/2025/08/250816-Rules-of-Heyball.pdf)与 [WPBSA 2024-25 Official Rules](https://www.wpbsa.com/wp-content/uploads/2198_WPBSA-Rulebook-2024-25.pdf)。Pooltool 只作为物理与软件架构参考，不作为赛事规则书。

Rust rules 模块采用 serde 兼容的纯函数状态机：

```text
(旧状态, 玩家动作, 权威物理摘要, 外部权威选择)
    -> (新状态, foulCode, points)
```

比赛状态保存完整静止球位、回合、比分、当前目标、球组、手中球区域、开球标记、待处理决策和赛果。`ping` 同时返回 `physicsVersion` 与 `rulesVersion`，以便回放或测试绑定行为版本。

### 4.1 中式八球

`chinese-eight-ball` profile 已实现：

- 标准 15 球三角摆球，8 号球居中，底角分属全色和花色；
- 发球线后手中球、合法开球所需的进球或四颗目标球碰库条件；
- 非法开球、开球犯规、开球进 8 及开球进 8 同时犯规的选择阶段；
- 开放球局、首碰合法目标、分组确定和同时满足两组时的玩家选择；
- 未碰合法目标、白球落袋、无进球且首碰后无碰库、非法跳球等犯规；
- 犯规后的自由球、合法连续击球，以及 8 号球胜负。

### 4.2 斯诺克

`snooker` profile 已实现：

- D 区开球，15 红球与六颗彩球标准摆放；
- 红球、提名彩球交替，最后红球后的彩球机会；
- 彩球复位、黄绿棕蓝粉黑顺序清台；
- 合法进球计分，犯规按目标球、首碰球、落袋球和跳越球价值计算罚分；
- 白球落袋后的 D 区手中球；
- 平分后的决胜黑球和由平台权威随机源驱动的先手选择。

### 4.3 练习与裁判边界

单人房间进入练习 profile：同一玩家连续击球，不累计正式犯规或结束比赛。双人 profile 不完整实现以下裁判流程：

- 斯诺克 `foul and a miss`、自由球、要求重打、复位协商、touching ball 和完整推杆判断；
- 球被迫离台后的正式移除、复位与罚分流程；
- 中式八球需要裁判判断击球意图、器材干扰或非物理输入才能确认的行为；
- 把物理层 `miscue` 诊断直接等同于规则犯规。

跳越检测已进入两种 profile 的物理摘要：斯诺克的实际跳球判犯规；中式八球只把当前 profile 定义的非法下塞跳越判犯规。以上是产品规则选择，不表示已覆盖正式规则书中的全部裁判裁量。

## 5. 击球输入与滑杆诊断

`billiards.shoot` 的权威输入为：

| 字段 | 范围 | 含义 |
| --- | --- | --- |
| `angle` | `[-π, π]` | 台面坐标中的瞄准方向 |
| `power` | `[1, 100]` | 经非线性曲线映射到球杆速度 |
| `tip.x`、`tip.y` | 单位球面半径 `0.95` 内 | 左右塞和高低杆击球点 |
| `elevation` | `[0°, 90°]` | 球杆仰角，影响平面冲量与竖直速度 |
| `nominatedColor` | 可空 | 斯诺克需要击彩时的提名 |

Rust 击球模型根据力度、击球点和仰角计算母球平面速度、三轴角速度、跳升速度与偏移角。返回的 `cueStrike` 诊断包含 `cueSpeed`、`jumpSpeed`、`squirtRadians` 和 `miscue`。

当前滑杆判断是明确的产品启发式：归一化击球点半径大于 `0.94` 时标记 `miscue`，输入 schema 的最大半径为 `0.95`；标记后会降低有效抓球与冲量。它没有模拟皮头形变、巧粉、杆身刚度、接触持续时间或二次触球，也不会仅凭诊断自动判规则犯规。若以后改变阈值或冲量映射，必须更新物理版本和回归基线。

`billiards.aim-preview` 仍是可丢弃的临时事件，只用于向对手展示方向、力度、击球点和仰角。它不改变房间修订号、不进入 Rust reducer，也不参与回放 hash。

## 6. 物理模拟

### 6.1 运动状态

每颗球在模拟期间处于以下离散状态之一：

- `stationary`：平动和自转均低于停止阈值；
- `spinning`：球心静止但仍有竖直轴自转；
- `sliding`：球与台呢接触点存在相对滑动；
- `rolling`：进入近似无滑滚动；
- `airborne`：具有简化高度与竖直速度；
- `pocketed`：已被袋口捕获的终止状态。

状态内保存位置、平面速度、竖直高度/速度、三轴角速度和渲染转角。台呢作用按状态分段解析演化，滑动、滚动、自转和落台会预测各自的转换时刻。

### 6.2 候选事件与事件队列

模拟不是按固定小步长推进。每轮会：

1. 由当前运动多项式预测状态转换、球球、直线库边、圆形袋角、袋口捕获和安全边界候选；
2. 按时间、事件优先级和稳定对象键排序；
3. 取最早时间容差桶，把所有球演化到该时刻；
4. 先处理袋口，再联合求解接触，最后处理边界和状态转换；
5. 接触改变轨迹后重新生成候选，直到全部静止或达到硬上限。

这里的“事件队列”是每次接触后重建并排序的候选集合，而不是长期保存所有旧事件的堆；碰撞后旧预测已经失效。球球与圆形几何的到达时间使用多项式根求解，包含四次方程；直线库边和安全边界使用较低阶解析式。单杆设有最大模拟时长和最大事件数，异常输入不能无限占用服务端。

### 6.3 球球、球库与多接触

- 球球碰撞使用法向恢复和受摩擦上限约束的切向冲量，并更新侧旋。
- 直线库边和圆形袋角共享接触约束表达，库边摩擦、恢复、切向响应和滚动扰动来自表面参数。
- 同一最早时间桶内的球球、球库接触先按稳定键排序，再用固定 24 轮投影 Gauss-Seidel 顺序冲量求解；最后进行小量穿透修正。
- 袋口事件优先于同一桶内的普通接触，已进袋球不会继续参与后续约束。
- 这是一种确定性的刚体近似，不是精确互补问题求解，也不模拟球、库胶和台呢的连续形变。

动画帧不是物理权威。服务端默认只得到最终状态和事件摘要；浏览器回放或 `predict` 需要时才以约 `60 Hz` 采样状态。

## 7. 场景几何与碰撞加速

产品内部统一使用米。标准 profile 参数为：

| 项目 | 中式八球 | 斯诺克 |
| --- | --- | --- |
| 比赛区 | `2.540 m × 1.260 m` | `3.569 m × 1.778 m` |
| 球径 | `0.05715 m` | `0.0525 m` |
| 仿真球质量 | `0.163 kg` | `0.142 kg` |
| 发球线/D 区 | 距底库 `0.635 m` | 发球线 `0.737 m`，D 半径 `0.292 m` |
| 黑球点 | 不适用 | 距顶库 `0.324 m` |

Rust `TableGeometry` 不再把整张球桌表示成四条无限平面：

- 长库和短库在六个袋口处分段；
- 角袋使用斜向 jaw 线段，中袋使用朝内 jaw 线段；
- 各线段端点建立圆形 knuckle，用于袋角擦碰；
- 袋本身使用圆形捕获区域，并检查球的高度；
- 每条直线库、圆形袋角和袋口都带静态 AABB。

球球候选先计算运动区间的 swept AABB，再按 x 轴 sweep-and-prune 排除不可能相交的球对；球与桌台几何也先做 swept AABB 重叠测试。当前没有更复杂的 BVH，因为标准球桌的几何数量固定且较小。

官方规则通过认证器材模板约束袋口轮廓，并没有给出适用于所有球桌的单一捕获圆。本产品的 jaw 深度、knuckle 半径和袋口捕获半径是可测试、可标定的几何近似，不是 WPA/WPBSA 器材认证。高球采用 2.5D 高度模型；安全边界会把未进袋球保留在可玩区域，因此尚未模拟完整离台飞行和台外落点。

## 8. 参数配置与标定

房间公开两个可配置参数：

- `tableFriction`：`0.12-0.28`，步进 `0.01`，默认 `0.20`。它映射到滑动摩擦、滚动减速度、侧旋衰减、库边摩擦、切向响应和恢复系数。
- `spinConvergence`：`0.5-2.0`，步进 `0.1`，默认 `1.0`。它缩放平面旋转向无滑滚动收敛的速度。

TypeScript 展示层的 `billiardsSurfaceParameters` 与 Rust 核心保持同一映射，测试应阻止两端漂移。球尺寸、质量、恢复、袋口几何、击球速度曲线、滑杆阈值、停止阈值和求解容差目前是随 WASM 发布的 profile 常量，不从开发机配置或未受控文件读取。

当前产品已具备参数入口、固定基线和回归测试，但没有自动拟合工具或已认证的实台测量数据集。后续标定应遵循：

1. 用版本化的滚动距离、碰库入射/反射、球球分离、袋角拒球和击球速度 fixture 记录测量条件；
2. 在离线工具中拟合候选参数，不在在线房间中动态学习；
3. 用事件序列、最终球位、跨 Node/浏览器 hash 和规则结果做 golden 回归；
4. 任何会改变权威结果的参数更新都提升 `physicsVersion`，规则语义变化提升 `rulesVersion`。

fixture 或标定工具尚未落库时，文档示例只能使用类似 `<calibration-fixture>.json` 的占位符，不能写入真实设备、账户、网络或开发机信息。

## 9. 回放、状态哈希与联网确定性

服务端是唯一权威：

- 出杆动作只携带输入参数；
- 服务端同步执行 WASM 物理与 Rust 规则 reducer；
- 房间快照只保存静止后的球位和规则状态；
- 展示事件保存本杆初始球位、击球参数、表面设置、裁定摘要、物理版本、兼容 checksum 和 `stateHash`；
- 浏览器用相同 WASM 重新采样动画，版本、checksum 或 `stateHash` 不一致时不采用该动画，最终视图仍服从服务端快照。

物理确定性依赖以下合同：

- Node 与浏览器加载同一份 WASM 字节；
- 所有输入拒绝非有限数值并限制范围；
- 候选事件、对象 ID、同时接触和输出数组采用稳定顺序；
- 权威输出做固定精度量化；
- 规则 reducer 无全局 I/O，权威随机选择由平台显式注入并固化到新状态；
- `physicsVersion` 与 `rulesVersion` 标识行为兼容边界。

`simulate` 和 `predict` 返回：

- 8 位 `checksum`：兼容现有 `billiards.shot` 展示事件；
- 32 个十六进制字符的 `stateHash`：覆盖量化后的最终球位、时长、有序物理事件和进袋顺序。

`stateHash` 是单杆物理结果的快速确定性指纹，不包含完整规则状态，也不是密码学签名，不能单独作为反作弊证据。新展示事件同时携带 `physicsVersion` 与 `stateHash`；解析旧事件时这两个字段默认空值，并尝试兼容 checksum 校验。原 p2 事件通常不会与新 Rust 结果得到相同 checksum，此时客户端安全跳过动画并直接显示权威快照，不承诺跨物理引擎播放旧轨迹。完整物理事件仍只用于模拟结果、测试和诊断，尚未形成持久化的整场事件日志。跨物理版本重放必须保存对应版本与输入，不能假设新 WASM 会复现旧版本结果。

## 10. AI 轨迹预测 API

Node 入口同步导出 `predictBilliardsTrajectory`，浏览器入口导出同名异步函数。输入包含：

```ts
{
  balls,
  mode,
  shot,
  tableFriction?,
  spinConvergence?,
  maxFrames?
}
```

预测调用同一权威事件驱动模拟器并对采样帧做有界降采样；返回每颗球的 `{ atMs, x, y, z, state }` 路径、首碰球、进袋球、checksum、`stateHash` 和 `physicsVersion`。`maxFrames` 会限制在安全范围内，调用方仍应限制候选杆数和并发量。

该 API 是 AI、提示线或分析工具的轨迹原语，不是完整 AI 玩家。当前插件不开放 bot 座位，也没有选杆搜索、规则价值函数、对手模型、参数不确定性或蒙特卡洛扰动；这些应在上层调用 predict，并继续让真实出杆走服务端权威 `simulate`。

## 11. 构建与测试

Rust crate 使用 edition 2024，并编译为 `cdylib` 与 `rlib`。仓库根部的 `rust-toolchain.toml` 固定 Rust 版本、Clippy、rustfmt 和 WebAssembly target；rustup 会按该合同自动选择工具链：

```bash
rustup target add wasm32-unknown-unknown
```

从仓库根目录构建台球 WASM：

```bash
pnpm --filter @tabletop/game-billiards build:native
```

台球包的 `prebuild`、`pretest` 和 `pretest:coverage` 会自动运行该步骤；`postbuild` 会复制 WASM 到发布目录。常用验证命令：

```bash
cargo fmt --manifest-path games/billiards/native/Cargo.toml -- --check
cargo clippy --manifest-path games/billiards/native/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path games/billiards/native/Cargo.toml
pnpm --filter @tabletop/game-billiards check:native
pnpm --filter @tabletop/game-billiards typecheck
pnpm --filter @tabletop/game-billiards test
pnpm --filter @tabletop/game-billiards build
pnpm check
```

包级 `test` 已包含 `cargo test` 和 Vitest；单独运行 `cargo test` 便于只定位 Rust 失败。

测试至少应覆盖：

- 固定输入重复执行、Node/WASM ABI、浏览器加载和跨端 checksum/hash 一致；
- 六种运动状态、状态转换、球球、直线库边、圆形袋角、进袋和安全上限；
- 同时首碰、球群/球库多接触、稳定事件顺序和无非有限数值；
- 高低杆、左右塞、仰角、跳越、滑杆诊断和三档表面参数；
- 两种标准摆球、置球区域、开球选择、分组、犯规、计分、清彩和决胜黑球；
- 展示事件回放失败回退到权威快照，及 `predict` 的帧数上限和结果稳定性。

## 12. 公开参考

- Pooltool GitHub 固定版本：<https://github.com/ekiefl/pooltool/tree/9a8abfe>
- Pooltool 官方文档：<https://pooltool.readthedocs.io/en/stable/>
- Pooltool 算法博客：<https://ekiefl.github.io/2020/12/20/pooltool-alg/>
- Pooltool 物理 theory：<https://ekiefl.github.io/2020/04/24/pooltool-theory/>
- Pooltool JOSS 论文：<https://doi.org/10.21105/joss.07301>
- WPA Rules of Heyball：<https://wpapool.com/rules/>
- WPBSA Rules of Snooker and English Billiards：<https://www.wpbsa.com/rules/>
