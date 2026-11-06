# dsh-pdfcraft

A PDF reader plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): embeds the official
[Mozilla PDF.js](https://github.com/mozilla/pdf.js) viewer components in a right-sidebar tab, so every PDF file
surface in DSH — file cards, chat mentions, `@file` references, the Files sidebar — opens into a real reader with
continuous scrolling, text selection, full-text search, page navigation and zooming.

Third in the `craft` family, alongside [dsh-gridcraft](https://github.com/hfanshu/dsh-gridcraft)
(spreadsheets) and dsh-wordcraft (Word documents). Unlike its siblings it is **read-only**: PDFs are not edited,
so there is no save-back route and no `sessions` dependency — bytes flow one way, from the workspace into the
viewer.

## What it does

- **Right-sidebar tab** — the `pdfcraft` tab kind claims `*.pdf` file addresses (plugin-configurable switch on
  the plugin's own detail page); a guide card opens a blank reader page.
- **Toolbar** — session scope selector, workspace file picker, page number input with `x / y` display,
  previous/next page, zoom in/out, fit-width, fit-page, actual size, live zoom percentage, full-text search with
  match counter, download-a-copy, reveal in file manager.
- **Official PDF.js** — the unmodified `pdfjs-dist` build (viewer components + module worker) served same-origin
  from the plugin; a small committed bridge page (`app/app.html` + `app/app.js`) assembles `PDFViewer`,
  `PDFLinkService`, `PDFFindController` on an `EventBus` and speaks the `pdfcraft:*` postMessage protocol
  (modeled on the GridCraft/WordCraft bridges, with origin + source guards both ways).
- **File-card button** — an "Open in PDF Reader" button on conversation file cards, resolved through
  `GET /api/dsh-pdfcraft/resolve` (deliverables coordinates → declared path).
- **Bilingual** — zh/en dictionaries follow the host language live (PDF.js itself renders no chrome here).

## Install / build

```bash
cd dsh-pdfcraft
npm run setup   # = npm install + npm run fetch-pdfjs + npm run build
npm test
```

`npm run fetch-pdfjs` downloads the pinned `pdfjs-dist` tarball from the npm registry into `static/vendor/`
(package layout preserved: `build/`, `web/`, `web/images/`). The vendor directory is gitignored and must be
fetched once after cloning; the panel shows a setup hint until then.

To wire into a DSH profile, add to the profile's `package.json`:

```json
{
  "dsh": { "profile": { "bundles": ["dsh-pdfcraft-plugin"] } },
  "dependencies": { "dsh-pdfcraft-plugin": "link:E:/path/to/dsh-pdfcraft" }
}
```

## Architecture

```
workspace .pdf
   │  remote.workspaceFiles.readBytes (client, session-scoped)
   ▼
PdfPanel (React, sidebar.right.pane.tab slot)
   │  pdfcraft:open {name, bytes}        postMessage, same-origin iframe
   ▼
app/app.js (bridge page)  ──  Eventbus  ──  PDFViewer / PDFFindController
   │  pdfcraft:loaded/page/scale/findresult/failed
   ▼
toolbar state (page x/y, zoom %, matches n/m)

GET /api/dsh-pdfcraft/app.html + /app.js   committed bridge page (no-cache)
GET /api/dsh-pdfcraft/vendor/*             pdfjs-dist build (immutable cache)
GET /api/dsh-pdfcraft/resolve              file-card coordinates → path (auth'd)
```

- **Host half** (`index.ts`, `routes.ts`): registers the three read-only surfaces; the resolve route is guarded
  by `ctx.inject(['sessionQuery'], …)` so a host without the service still mounts the reader. Vendor path
  containment mirrors the siblings (`resolveInsideWorkspace`).
- **Client half** (`src/client`): two-stage sidebar-right registration (tab type + keyed body/title slots), the
  file-card button (`deliverables.file.actions` slot), and the default-opener switch (`plugins.bundle.config`
  slot, volatile Config field) — all identical in shape to dsh-gridcraft / dsh-wordcraft.
- **Bridge page** (`app/`): import order is load-bearing — `build/pdf.min.mjs` must evaluate before
  `web/pdf_viewer.mjs` (the components read `globalThis.pdfjsLib`, installed as a module side effect). The
  worker is a module worker served from the same vendor route.

## pdf.js v6 notes

Validated against `pdfjs-dist@6.4.299`:

- `PDFFindController#executeCommand` **no longer exists** — find is driven through
  `eventBus.dispatch('find', { type: '' | 'again', query, highlightAll, findPrevious, … })`.
- Event names are `pagechanging` / `scalechanging` (`pagechange` / `scalechange` do not exist).
- Page geometry is unknown before `pagesinit`; set `currentScaleValue = 'page-width'` in a one-shot
  `pagesinit` handler, not right after `setDocument`.

## Known limitations

- Read-only: no annotation editing / save-back (candidate for v2 — pdf.js ships an annotation editor layer, and
  the gridcraft save route is a known-good template for write-back).
- The default view is fit-width; per-document zoom persistence is out of scope.
- The embedded viewer is English-agnostic chrome-less (all labels live in the host panel), so it follows the
  host language without any PDF.js locale files.
- Files above the `workspaceFiles.readBytes` cap (32 MiB) are refused with a clear message.
