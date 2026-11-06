/**
 * HTTP routes for dsh-pdfcraft — three surfaces, all same-origin with the web
 * GUI (the bridge iframe must be same-origin for a frictionless postMessage
 * channel, so the viewer assets MUST be served by this host, not a CDN):
 *
 * - GET /api/dsh-pdfcraft/app.html + /app.js — the bridge page the panel
 *   hosts in an iframe (committed source under app/). It boots the official
 *   PDF.js viewer components and speaks the `pdfcraft:*` postMessage
 *   protocol. Unlike its siblings this plugin is read-only (PDFs are not
 *   edited), so there is no save route and no `sessions` dependency.
 * - GET /api/dsh-pdfcraft/vendor/* — the PDF.js build from static/ (fetched
 *   by scripts/fetch-pdfjs.mjs, package layout preserved: build/ + web/ +
 *   web/images/). The fetch script rewrites the whole directory on version
 *   bumps, so immutable caching is safe.
 * - GET /api/dsh-pdfcraft/resolve — turns deliverables file-card coordinates
 *   (sessionId/seq/index) into the declared file's path, the missing half of
 *   the deliverables.file.actions slot whose owner props carry only the
 *   authenticated actionUrl.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ApiResponse } from './types.js'

/** Bridge page paths (exact routes). */
export const PC_APP_HTML_PATH = '/api/dsh-pdfcraft/app.html'
export const PC_APP_JS_PATH = '/api/dsh-pdfcraft/app.js'
/** Vendor build base path (prefix route). */
export const PC_VENDOR_BASE = '/api/dsh-pdfcraft/vendor'
/** Presented-file resolve endpoint path (exact route). */
export const PC_RESOLVE_PATH = '/api/dsh-pdfcraft/resolve'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

export interface PcRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/**
 * Serve one committed bridge-page source file from `appDir` (app.html /
 * app.js). Always revalidates: the files are plugin source, not hashed
 * assets, so an upgrade must pick up the new bytes immediately.
 */
function createAppSourceRoute(options: { urlPath: string, fileName: string, appDir: string, mime: string }): PcRoute {
  const { urlPath, fileName, appDir, mime } = options
  return {
    kind: 'exact',
    path: urlPath,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { success: false, error: 'method not allowed' })
        return
      }
      const target = resolveInsideWorkspace(appDir, fileName)
      if (target === undefined || !existsSync(target) || !statSync(target).isFile()) {
        sendJson(res, 404, { success: false, error: 'not found' })
        return
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-cache',
        'Content-Length': statSync(target).size,
      })
      if (req.method === 'HEAD') { res.end(); return }
      createReadStream(target).pipe(res)
    },
  }
}

/**
 * Serve the PDF.js vendor build from `staticDir` under /vendor/*. Path
 * containment mirrors the siblings' save routes; immutable caching is safe
 * because the fetch script rewrites the whole directory on version bumps.
 */
function createVendorRoute(options: { staticDir: string }): PcRoute {
  const { staticDir } = options
  return {
    kind: 'prefix',
    path: PC_VENDOR_BASE,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { success: false, error: 'method not allowed' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      let relative = url.pathname.slice(PC_VENDOR_BASE.length)
      if (relative === '' || relative === '/') relative = '/index.html'
      const decoded = decodeURIComponent(relative).replace(/\\/g, '/')
      const target = resolveInsideWorkspace(staticDir, decoded.replace(/^\//, ''))
      if (target === undefined) {
        sendJson(res, 400, { success: false, error: 'bad vendor path' })
        return
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        sendJson(res, 404, { success: false, error: 'not found' })
        return
      }
      const ext = path.extname(target).toLowerCase()
      // The vendor files are fetched per fixed version; cache them hard, the
      // fetch script's --force bump is the invalidation path.
      const cache = 'public, max-age=31536000, immutable'
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Cache-Control': cache,
        'Content-Length': statSync(target).size,
      })
      if (req.method === 'HEAD') { res.end(); return }
      createReadStream(target).pipe(res)
    },
  }
}

function sendJson(res: ServerResponse, status: number, data: ApiResponse): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/**
 * Workspace-relative path (posix separators) → absolute path inside `root`,
 * or `undefined` when the value escapes containment or is not a plain
 * relative path. Rejects absolute paths, drive letters, NUL and `..`.
 */
export function resolveInsideWorkspace(root: string, relative: string): string | undefined {
  if (typeof relative !== 'string' || relative === '') return undefined
  if (relative.includes('\0')) return undefined
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) return undefined
  const normalized = path.posix.normalize(relative.replace(/\\/g, '/'))
  if (normalized === '' || normalized === '.' || normalized.startsWith('../') || normalized === '..') return undefined
  const absolute = path.resolve(root, ...normalized.split('/'))
  const rootResolved = path.resolve(root)
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + path.sep)) return undefined
  return absolute
}

/** The sessionQuery face the resolve route needs (mirrors the ambient dsh-host.d.ts). */
export interface SessionQueryFace {
  readEvent(query: {
    sessionId: string
    seq: number
    before: number
    after: number
  }, signal?: AbortSignal): Promise<{
    target: { type: string, data?: unknown }
    session?: { cwd?: string }
  }>
}

/** Numeric query coordinate (`/^\d+$/`, safe integer) or `undefined`. */
function coordinate(value: string | null): number | undefined {
  return value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
}

/**
 * Create the presented-file resolve route: `GET /api/dsh-pdfcraft/resolve
 * ?sessionId=&seq=&index=` reads the `deliverables/presented` event at the
 * given Session coordinates and returns the declared file's (path, name).
 */
export function createResolveRoute(options: { sessionQuery: SessionQueryFace }): PcRoute {
  const { sessionQuery } = options
  return {
    kind: 'exact',
    path: PC_RESOLVE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { success: false, error: 'method not allowed' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const seq = coordinate(url.searchParams.get('seq'))
      const index = coordinate(url.searchParams.get('index'))
      if (sessionId === '' || seq === undefined || index === undefined) {
        sendJson(res, 400, { success: false, error: 'invalid presented file coordinates' })
        return
      }
      try {
        const read = await sessionQuery.readEvent({ sessionId, seq, before: 0, after: 0 })
        const data = read.target?.type === 'deliverables/presented'
          ? read.target?.data as { files?: unknown } | undefined
          : undefined
        const file = data !== undefined && Array.isArray(data.files) ? data.files[index] : undefined
        const filePath = typeof (file as { path?: unknown } | undefined)?.path === 'string'
          ? (file as { path: string }).path
          : ''
        if (filePath === '') {
          sendJson(res, 404, { success: false, error: 'presented file not found' })
          return
        }
        const name = filePath.split(/[\\/]/).pop() ?? filePath
        sendJson(res, 200, { success: true, data: { sessionId, path: filePath, name } })
      } catch (error) {
        const message = (error as Error)?.message ?? 'resolve failed'
        sendJson(res, 502, { success: false, error: message })
      }
    },
  }
}

/** Create the plugin's routes: bridge page + vendor build (read-only plugin). */
export function createPdfcraftRoutes(options: {
  appDir: string
  staticDir: string
}): PcRoute[] {
  const { appDir, staticDir } = options

  return [
    // ── committed bridge page (the panel's iframe document) ──
    createAppSourceRoute({
      urlPath: PC_APP_HTML_PATH,
      fileName: 'app.html',
      appDir,
      mime: 'text/html; charset=utf-8',
    }),
    createAppSourceRoute({
      urlPath: PC_APP_JS_PATH,
      fileName: 'app.js',
      appDir,
      mime: 'text/javascript; charset=utf-8',
    }),

    // ── PDF.js vendor build ──
    createVendorRoute({ staticDir }),
  ]
}
