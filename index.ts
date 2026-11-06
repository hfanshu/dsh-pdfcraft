/**
 * dsh-pdfcraft — embed the official PDF.js viewer components in a DSH
 * right-sidebar tab, reading workspace PDF files through the host.
 *
 * PDF.js (npm `pdfjs-dist`, Mozilla) is the reference browser PDF engine. Its
 * viewer component library (`web/pdf_viewer.mjs`) provides the continuous-
 * scroll page renderer, the text selection layer and the find controller;
 * the plugin wraps them in a small same-origin bridge page and speaks a
 * postMessage protocol modeled on the GridCraft/WordCraft bridges. This
 * plugin is READ-ONLY (PDFs are not edited): there is no save route and no
 * `sessions` dependency — bytes flow one way, from the workspace into the
 * viewer.
 *
 * - child → parent: {type:'pdfcraft:ready', version}
 *                   {type:'pdfcraft:loaded', pages}
 *                   {type:'pdfcraft:page', page, pages}
 *                   {type:'pdfcraft:scale', scale}
 *                   {type:'pdfcraft:findresult', matches, current}
 *                   {type:'pdfcraft:failed', error}
 * - parent → child: {type:'pdfcraft:open', name, bytes}
 *                   {type:'pdfcraft:goto', page}
 *                   {type:'pdfcraft:zoom', mode}
 *                   {type:'pdfcraft:find', query, again}
 *
 * Host half: serves the committed bridge page (app/) and the vendor build
 * (static/, fetched by scripts/fetch-pdfjs.mjs) at /api/dsh-pdfcraft/*, plus
 * /api/dsh-pdfcraft/resolve, which turns deliverables file-card coordinates
 * into the declared file's path.
 *
 * Client half (src/client): registers the `pdfcraft` right-sidebar tab type
 * (guide card + .pdf file-address patterns), hosting the iframe; lists PDF
 * files from the selected Session's workspace via remote.workspaceFiles, and
 * bridges open/goto/zoom/find messages.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPdfcraftRoutes, createResolveRoute, PC_APP_HTML_PATH, PC_APP_JS_PATH, PC_VENDOR_BASE } from './routes.js'
import type { PdfcraftConfig } from './types.js'

/** Stable cordis plugin id (matches the bundle patch `id: pdfcraft`). */
export const name = 'pdfcraft'

/** Services required before the surfaces can mount (read-only: no sessions). */
export const inject = ['webServer']

/**
 * Plugin config schema — the plugins settings page auto-generates the form
 * from this (SettingsForms reads the entry fiber's static `Config`). Only
 * `.volatile()` fields accept live edits (`settings/rejected` otherwise), so
 * the switch writes through without restarting this plugin fiber; the client
 * reads the live value through `ctx.configForms.get('pdfcraft')` for its
 * routing decisions.
 */
export const Config = z.object({
  defaultOpener: z.boolean().default(true).volatile()
    .description('点击 PDF 文件时默认在 PdfCraft 中打开；关闭后使用内建预览 (Open PDF files with PdfCraft by default; off = built-in preview)'),
})

/** Single-active guard: blocks a concurrent double-activation, and resets when
 * the fiber disposes — a config edit restarts the plugin, and the restart must
 * re-run apply (the same module instance is reused). */
let active = false

function mountOnce(apply: (ctx: Context, config?: PdfcraftConfig) => void) {
  return (ctx: Context, config?: PdfcraftConfig) => {
    if (active) return
    active = true
    ctx.effect(() => () => { active = false }, 'dsh-pdfcraft: mount guard')
    apply(ctx, config)
  }
}

/** Host-half apply: mount bridge page + vendor routes. */
function applyImpl(ctx: Context, config?: PdfcraftConfig): void {
  if (config?.enabled === false) {
    console.log('[dsh-pdfcraft] Plugin disabled by config')
    return
  }

  // lib/index.js → plugin root (repo layout: app/ and static/ beside package.json).
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const appDir = resolve(pluginRoot, 'app')
  // The vendor prefix consumes the /vendor/ segment, so the route root is the
  // vendor directory itself (static/vendor/build/pdf.min.mjs serves at
  // /api/dsh-pdfcraft/vendor/build/pdf.min.mjs).
  const staticDir = resolve(pluginRoot, 'static', 'vendor')
  if (!existsSync(resolve(appDir, 'app.html'))) {
    console.warn('[dsh-pdfcraft] app/app.html missing — the plugin install is incomplete; the panel will show a setup hint until then')
  }
  if (!existsSync(resolve(staticDir, 'build', 'pdf.min.mjs'))) {
    console.warn('[dsh-pdfcraft] static/vendor/build/pdf.min.mjs missing — run `npm run fetch-pdfjs` in the plugin directory; the panel will show a setup hint until then')
  }

  const disposers: (() => void)[] = []
  for (const route of createPdfcraftRoutes({ appDir, staticDir })) {
    disposers.push(ctx.webServer.register(route))
  }

  // The resolve route needs the host sessionQuery service; guard it so a host
  // without the service still mounts the page + vendor surfaces. cordis runs
  // the inject callback as its own plugin — the services are reachable only
  // through the callback's derived context, not the outer closure (the outer
  // ctx trips the "cannot get property … without inject" guard).
  ctx.inject(['sessionQuery'], (serviceCtx) => {
    try {
      disposers.push(ctx.webServer.register(createResolveRoute({
        sessionQuery: (serviceCtx as Context & { sessionQuery: NonNullable<Context['sessionQuery']> }).sessionQuery,
      })))
      console.log('[dsh-pdfcraft] resolve route registered at /api/dsh-pdfcraft/resolve')
    } catch (error) {
      console.warn('[dsh-pdfcraft] Failed to register resolve route:', error)
    }
  })

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'dsh-pdfcraft: routes')

  console.log(`[dsh-pdfcraft] Plugin initialized — page at ${PC_APP_HTML_PATH}, vendor at ${PC_VENDOR_BASE}/ (app.js at ${PC_APP_JS_PATH})`)
}

export const apply = mountOnce(applyImpl)
