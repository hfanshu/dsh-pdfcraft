/**
 * postMessage bridge to the embedded PDF.js viewer page (`app/app.js`).
 *
 * Wire shapes (the counterpart lives in the viewer page):
 * - child → parent: {type:'pdfcraft:ready', version}            viewer booted, opens accepted
 *                   {type:'pdfcraft:loaded', pages, name}       a document finished opening
 *                   {type:'pdfcraft:page', page, pages}         the current page changed
 *                   {type:'pdfcraft:scale', scale}              the zoom changed
 *                   {type:'pdfcraft:findresult', matches, current}  find state updated
 *                   {type:'pdfcraft:failed', error}             boot/open failure
 * - parent → child: {type:'pdfcraft:open', name, bytes}         open a workspace PDF
 *                   {type:'pdfcraft:goto', page}                jump to a page
 *                   {type:'pdfcraft:zoom', mode}                'in'|'out'|'width'|'page'|'actual'
 *                   {type:'pdfcraft:find', query, again, previous}  run/continue a find
 *                   {type:'pdfcraft:focusfind'}                 Ctrl+F inside the document
 *
 * Both sides guard on origin + source, mirroring the sibling bridges: the
 * panel only accepts events whose source is the iframe's contentWindow.
 */

export type PdfcraftZoomMode = 'in' | 'out' | 'width' | 'page' | 'actual'

export type PdfcraftInbound =
  | { type: 'pdfcraft:ready', version: string }
  | { type: 'pdfcraft:loaded', pages: number, name: string }
  | { type: 'pdfcraft:page', page: number, pages: number }
  | { type: 'pdfcraft:scale', scale: number }
  | { type: 'pdfcraft:findresult', matches: number, current: number }
  | { type: 'pdfcraft:focusfind' }
  | { type: 'pdfcraft:failed', error: string }

export function isInbound(data: unknown): data is PdfcraftInbound {
  return typeof data === 'object' && data !== null
    && typeof (data as { type?: unknown }).type === 'string'
    && String((data as { type: string }).type).startsWith('pdfcraft:')
}

/** Send a PDF to the iframe. Structured clone copies the buffer, so the parent keeps its own. */
export function sendOpen(win: Window | null, name: string, bytes: Uint8Array): void {
  if (win === null) return
  // Copy into a plain ArrayBuffer so detach/transfer semantics can never
  // alias the remote's buffer.
  const copy = bytes.slice().buffer
  win.postMessage({ type: 'pdfcraft:open', name, bytes: copy }, window.location.origin)
}

export function sendGoto(win: Window | null, page: number): void {
  win?.postMessage({ type: 'pdfcraft:goto', page }, window.location.origin)
}

export function sendZoom(win: Window | null, mode: PdfcraftZoomMode): void {
  win?.postMessage({ type: 'pdfcraft:zoom', mode }, window.location.origin)
}

export function sendFind(win: Window | null, query: string, again: boolean, previous = false): void {
  win?.postMessage({ type: 'pdfcraft:find', query, again, previous }, window.location.origin)
}

/**
 * Pending open request: `pdfcraft:open` sent before the app posts
 * `pdfcraft:ready` would be dropped (the viewer is still loading its module
 * graph), so the panel holds the request and flushes it on ready.
 */
export interface PendingOpen {
  name: string
  bytes: Uint8Array
}
