# 2D 场景与碰撞区编辑器

仓库内置的 Scene Draft 是一个只在本机运行的开发工具，用于绘制游戏界面、矢量装饰、图片和碰撞区，并导出可由游戏直接加载的 `tabletop.scene/v1` JSON 描述文件。编辑器与游戏侧运行时共用 `@tabletop/scene` 包，避免各自实现坐标换算。

## 启动

先安装仓库依赖，然后启动独立编辑器：

```bash
pnpm install --frozen-lockfile
pnpm dev:scene
```

浏览器访问 `http://127.0.0.1:4173/`。该命令只监听 loopback，不会把编辑器暴露到局域网。

编辑器会把当前场景自动暂存到浏览器本地存储。正式保存使用顶部“导出 JSON”；“打开”可以继续编辑之前导出的 `.scene.json` 文件。

## 绘制能力

- 矩形、圆角矩形、椭圆；
- 直线、单向或双向箭头、折线、多边形、平滑自由线；
- 独立文字元素，以及每个元素自带的画布标注、备注和标签；
- URL 图片和嵌入式图片。URL 可以是相对描述文件的资源地址；本地图片会保存为 data URL；
- 图层排序、显示、锁定、拖动、缩放、旋转、透明度、填充、描边、虚线和网格吸附；
- `visual`、`collision`、`both` 三种用途。开启“碰撞区”后，碰撞几何以红色虚线叠加显示。

折线和多边形逐点单击绘制，双击或按 Enter 完成，Escape 取消；多边形也可以点击首点闭合。按住 Alt 可临时关闭网格吸附。常用快捷键显示在左侧工具栏；另外支持：

| 操作 | 快捷键 |
| --- | --- |
| 撤销 / 重做 | Ctrl/Cmd + Z / Ctrl/Cmd + Shift + Z |
| 导出 | Ctrl/Cmd + S |
| 复制选中元素 | Ctrl/Cmd + D |
| 删除选中元素 | Delete 或 Backspace |
| 微移 | 方向键；按住 Shift 使用一个网格步长 |

## 坐标契约

描述文件固定使用以下坐标定义：

- 原点在场景左上角；
- X 轴向右，Y 轴向下；
- 设计尺寸下 `1 scene-unit` 对应 `1 CSS px`；
- 画布适配使用 `contain` 等比缩放，剩余空间居中留白；
- 元素按 `elements` 数组从前到后绘制，即数组末尾位于最上层；
- 元素旋转角度使用度，正值为顺时针，旋转中心是元素未旋转包围盒的中心。

编辑器的 SVG `viewBox` 与描述文件的 `canvas.width`、`canvas.height` 完全相同。游戏侧的 `calculateSceneViewport`、`sceneToViewport` 和 `viewportToScene` 使用同一 `contain` 公式，因此游戏逻辑应始终保存和计算 scene-unit，只在输入与渲染边界转换到视口坐标。

例如，设计画布为 `1000 × 500`，实际容器为 `800 × 800` 时，缩放值为 `0.8`，顶部和底部各留白 `200`。场景点 `(250, 125)` 对应视口点 `(200, 300)`，反向换算会得到同一个场景点。

## 描述文件

[示例场景](examples/scene-v1.example.json)包含视觉元素、碰撞区、文字和图片资源链接。顶层结构如下：

```ts
interface SceneDocumentV1 {
  format: "tabletop.scene";
  formatVersion: 1;
  name: string;
  canvas: {
    width: number;
    height: number;
    background: string;
    gridSize: number;
    coordinateSystem: {
      origin: "top-left";
      xAxis: "right";
      yAxis: "down";
      unit: "scene-unit";
    };
    scaleMode: "contain";
  };
  elements: SceneElement[];
}
```

所有元素都有稳定 `id`、名称、用途、可见性、锁定状态、透明度、旋转、样式和标注元数据。不同元素额外保存以下几何参数：

| 类型 | 几何数据 |
| --- | --- |
| `rectangle` | `x`、`y`、`width`、`height`、`cornerRadius` |
| `ellipse` | `cx`、`cy`、`rx`、`ry` |
| `line` | `start`、`end`、起止箭头 |
| `polyline` | 完整 `points` 数组和 `closed` |
| `freehand` | 完整采样点和 `smoothing` |
| `text` | 锚点、文本、字体、字号、行高、对齐和最大宽度 |
| `image` | `x`、`y`、尺寸、`source` 资源链接、替代文本和填充方式 |

运行时校验器会拒绝未知格式版本、非法尺寸、非有限坐标和重复元素 ID。修改格式时应新增版本和迁移逻辑，不要静默改变 v1 含义。

## 在游戏中加载

游戏包在 `package.json` 中声明共享运行时：

```json
{
  "dependencies": {
    "@tabletop/scene": "workspace:*"
  }
}
```

加载描述文件并解析相对图片资源：

```ts
import {
  fetchSceneDocument,
  resolveSceneAssetSource,
  type ImageElement,
} from "@tabletop/scene";

const descriptorUrl = new URL("./assets/board.scene.json", import.meta.url);
const scene = await fetchSceneDocument(descriptorUrl);

const imageElements = scene.elements.filter(
  (element): element is ImageElement => element.type === "image",
);
const assetUrls = imageElements.map((element) =>
  resolveSceneAssetSource(element.source, descriptorUrl),
);
```

在 Canvas 2D 中按相同坐标绘制：

```ts
import { renderSceneToCanvas } from "@tabletop/scene";

const bounds = canvas.getBoundingClientRect();
const ratio = window.devicePixelRatio;
canvas.width = Math.round(bounds.width * ratio);
canvas.height = Math.round(bounds.height * ratio);

const context = canvas.getContext("2d");
if (context === null) throw new Error("Canvas 2D 不可用");
context.setTransform(ratio, 0, 0, ratio, 0, 0);

renderSceneToCanvas(context, scene, {
  width: bounds.width,
  height: bounds.height,
  images: loadedImages,
});
```

`loadedImages` 是以描述文件中原始 `source` 为 key、以已经加载的 `CanvasImageSource` 为 value 的 Map。未加载到的图片会显示占位框，不影响矢量元素和碰撞区。

把指针坐标转换成游戏坐标并查询碰撞区：

```ts
import {
  calculateSceneViewport,
  hitTestScene,
  viewportToScene,
} from "@tabletop/scene";

const bounds = canvas.getBoundingClientRect();
const transform = calculateSceneViewport(scene.canvas, {
  width: bounds.width,
  height: bounds.height,
});
const point = viewportToScene(
  {
    x: pointerEvent.clientX - bounds.left,
    y: pointerEvent.clientY - bounds.top,
  },
  transform,
);

const collision = hitTestScene(scene, point, {
  roles: ["collision", "both"],
  tolerance: 0,
});
```

`hitTestScene` 从最上层向下查询，默认只匹配 `collision` 和 `both`。矩形使用圆角范围，椭圆使用 `(x − cx)² / rx² + (y − cy)² / ry² ≤ 1`，线段与开放路径使用到线段的距离，多边形使用点在多边形内判定，文字和图片使用包围盒。它适合点击、热点、出生区和区域触发；连续刚体物理仍应把导出的几何数据交给游戏自己的权威物理引擎。

## 资源与版本控制

- 正式游戏资源应放在对应游戏的可发布资源目录中（例如 `web/assets`，或与描述文件同目录的 `scenes/<mode>`），并在描述文件中使用可随构建产物迁移的相对链接。
- data URL 适合小型草图和原型，会显著增大 JSON，不建议用于大型正式素材。
- 提交前同时检查描述文件和图片资源，确保没有开发机器路径、私有地址或临时 blob URL。
- `blob:` URL 只在当前浏览器会话有效，不应用于需要提交或发布的描述文件。
