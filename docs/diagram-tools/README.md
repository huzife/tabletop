# 图示维护

设计文档同时提交 Markdown、可编辑图源和渲染后的 PNG。结构图使用 SVG，行为图使用 PlantUML。

## 重新生成结构图

结构图由仓库内脚本生成：

```bash
python3 docs/diagram-tools/build_svgs.py
```

脚本只依赖 Python 标准库，输出到 `docs/images` 和 `docs/games/images`。修改布局时先改脚本，再提交生成的 SVG。

## 渲染 PNG

PlantUML 图源需要 Java 和 `plantuml.jar`，SVG 渲染需要 CairoSVG。可以使用任意等价工具，但输出文件名必须与图源主文件名一致。当前环境的参考命令是：

```bash
JAVA_TOOL_OPTIONS=-Djava.awt.headless=true \
python3 /path/to/render_diagrams.py docs/images

JAVA_TOOL_OPTIONS=-Djava.awt.headless=true \
python3 /path/to/render_diagrams.py docs/games/images
```

渲染后必须逐张检查文字压盖、连线穿框、画布越界和中文字体。Markdown、`.svg`/`.puml` 与 `.png` 应在同一次提交中更新。
