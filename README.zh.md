# dsh-pdfcraft

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 PDF 阅读器插件：把 Mozilla 官方
[PDF.js](https://github.com/mozilla/pdf.js) viewer 组件嵌进右侧边栏 Tab，让 DSH 里所有 PDF 文件入口 ——
文件卡片、对话提及、`@file` 引用、Files 侧栏 —— 都在真正的阅读器中打开，支持连续滚动、文本选择、
全文搜索、页码跳转与缩放。

`craft` 家族第三员，与 [dsh-gridcraft](https://github.com/hfanshu/dsh-gridcraft)（电子表格）、
dsh-wordcraft（Word 文档）同构。与两位兄长不同的是它是**只读**的：PDF 不做编辑，因此没有写回路由、
不依赖 `sessions` 服务 —— 字节单向流动，从工作区到阅读器。

## 功能

- **右侧边栏 Tab** —— `pdfcraft` Tab 类型接管 `*.pdf` 文件地址（插件详情页有默认打开开关）；guide 卡
  打开空白阅读页。
- **工具栏** —— 会话范围选择器、工作区文件选择器、页码输入与 `x / y` 显示、上一/下一页、放大/缩小、
  适宽、适页、实际大小、实时缩放百分比、全文搜索（命中计数）、下载副本、在资源管理器中显示。
- **官方 PDF.js** —— 未修改的 `pdfjs-dist` 构建（viewer 组件 + module worker）由插件同源服务；提交在
  仓库里的小桥接页（`app/app.html` + `app/app.js`）在 `EventBus` 上装配 `PDFViewer` / `PDFLinkService` /
  `PDFFindController`，用 `pdfcraft:*` postMessage 协议与面板通信（照 GridCraft/WordCraft 桥的样子，
  双向校验 origin + source）。
- **文件卡片按钮** —— 对话文件卡片上的「在 PDF 阅读器中打开」按钮，经
  `GET /api/dsh-pdfcraft/resolve` 解析（presented 坐标 → 声明路径）。
- **中英双语** —— zh/en 字典实时跟随宿主语言（本阅读器中 PDF.js 不渲染任何界面文字）。

## 安装 / 构建

```bash
cd dsh-pdfcraft
npm run setup   # = npm install + npm run fetch-pdfjs + npm run build
npm test
```

`npm run fetch-pdfjs` 从 npm registry 下载锁定版本的 `pdfjs-dist` tarball 到 `static/vendor/`
（保留包内布局：`build/`、`web/`、`web/images/`）。vendor 目录不进 git，克隆后需执行一次；未就绪时
面板会显示安装提示。

接入 DSH profile：在 profile 的 `package.json` 中加入：

```json
{
  "dsh": { "profile": { "bundles": ["dsh-pdfcraft-plugin"] } },
  "dependencies": { "dsh-pdfcraft-plugin": "link:E:/path/to/dsh-pdfcraft" }
}
```

## 架构

```
工作区 .pdf
   │  remote.workspaceFiles.readBytes（客户端，会话作用域）
   ▼
PdfPanel（React，sidebar.right.pane.tab 槽）
   │  pdfcraft:open {name, bytes}        postMessage，同源 iframe
   ▼
app/app.js（桥接页）  ──  EventBus  ──  PDFViewer / PDFFindController
   │  pdfcraft:loaded/page/scale/findresult/failed
   ▼
工具栏状态（页码 x/y、缩放 %、命中 n/m）

GET /api/dsh-pdfcraft/app.html + /app.js   提交的桥接页（no-cache）
GET /api/dsh-pdfcraft/vendor/*             pdfjs-dist 构建（immutable 缓存）
GET /api/dsh-pdfcraft/resolve              文件卡片坐标 → 路径（需鉴权）
```

- **宿主半**（`index.ts`、`routes.ts`）：注册三个只读面；resolve 路由用
  `ctx.inject(['sessionQuery'], …)` 守卫，宿主缺该服务时阅读器仍可挂载。vendor 路径遏制与两个先例
  一致（`resolveInsideWorkspace`）。
- **客户端半**（`src/client`）：两段式 sidebar-right 注册（Tab 类型 + keyed body/title 槽）、文件卡片
  按钮（`deliverables.file.actions` 槽）、默认打开开关（`plugins.bundle.config` 槽，volatile Config
  字段）—— 形状与 dsh-gridcraft / dsh-wordcraft 完全一致。
- **桥接页**（`app/`）：import 顺序有语义 —— `build/pdf.min.mjs` 必须先于 `web/pdf_viewer.mjs` 求值
  （组件读取 `globalThis.pdfjsLib`，由 build 以模块副作用安装）。worker 是 module worker，由同一条
  vendor 路由服务。

## pdf.js v6 要点

针对 `pdfjs-dist@6.4.299` 验证：

- `PDFFindController#executeCommand` **已移除** —— 搜索改经
  `eventBus.dispatch('find', { type: '' | 'again', query, highlightAll, findPrevious, … })` 驱动。
- 事件名是 `pagechanging` / `scalechanging`（不存在 `pagechange` / `scalechange`）。
- 页面几何尺寸在 `pagesinit` 之前未知；`currentScaleValue = 'page-width'` 要放在一次性的
  `pagesinit` 处理器里设置，紧跟 `setDocument` 写入会被静默忽略。

## 已知限制

- 只读：无批注编辑 / 写回（v2 候选 —— pdf.js 自带批注编辑层，gridcraft 的 save 路由是写回的现成模板）。
- 默认视图适宽；不按文档记忆缩放。
- 内嵌阅读器无界面文字（所有标签在宿主面板），因此无需 PDF.js locale 文件即跟随宿主语言。
- 超过 `workspaceFiles.readBytes` 上限（32 MiB）的文件会被拒绝并给出明确提示。
