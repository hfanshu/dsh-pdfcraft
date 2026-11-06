/**
 * PdfCraft bridge — official PDF.js viewer components + the pdfcraft:*
 * postMessage protocol, the counterpart of the panel (src/client/PdfPanel.tsx)
 * and its bridge.ts. This page always runs as a same-origin iframe of the DSH
 * web GUI; both directions guard on event.source === window.parent and
 * matching origin, mirroring the sibling bridges.
 *
 * PDF.js v6 assembly notes (validated against pdfjs-dist@6.4.299):
 * - `build/pdf.min.mjs` must evaluate BEFORE `web/pdf_viewer.mjs`: the viewer
 *   component bundle destructures `globalThis.pdfjsLib`, which the build
 *   installs as a module side effect. ES module graphs evaluate imports in
 *   declaration order (depth-first), so the two static imports below are
 *   ordered deliberately — do not sort them.
 * - The worker is a module worker; it must be same-origin and served with a
 *   JS MIME (the plugin's vendor route handles both).
 * - The viewer components bind NO keyboard shortcuts (that lives in the
 *   upstream viewer.js app); this page adds only Ctrl+F (→ panel's search
 *   box) and +/- zoom. Scrolling/paging rides native overflow scrolling.
 *
 * Wire shapes:
 * - child → parent: {type:'pdfcraft:ready', version}
 *                   {type:'pdfcraft:loaded', pages, name}
 *                   {type:'pdfcraft:page', page, pages}
 *                   {type:'pdfcraft:scale', scale}
 *                   {type:'pdfcraft:findresult', matches, current}
 *                   {type:'pdfcraft:focusfind'}
 *                   {type:'pdfcraft:failed', error}
 * - parent → child: {type:'pdfcraft:open', name, bytes}
 *                   {type:'pdfcraft:goto', page}
 *                   {type:'pdfcraft:zoom', mode}   'in'|'out'|'width'|'page'|'actual'
 *                   {type:'pdfcraft:find', query, again, previous}
 *                   {type:'pdfcraft:focusfind'}
 */
import * as pdfjsLib from '/api/dsh-pdfcraft/vendor/build/pdf.min.mjs'
// ORDER MATTERS: pdf.min.mjs above installs globalThis.pdfjsLib first.
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from '/api/dsh-pdfcraft/vendor/web/pdf_viewer.mjs'

;(function () {
  'use strict'

  var parent = window.parent
  if (parent === window) return // not framed: nothing to bridge

  pdfjsLib.GlobalWorkerOptions.workerSrc = '/api/dsh-pdfcraft/vendor/build/pdf.worker.min.mjs'

  // ── outbound ─────────────────────────────────────────────────────────
  var parentOrigin = null
  try { parentOrigin = parent.location.origin } catch { parentOrigin = null }

  function post(message) {
    if (parentOrigin === null) return
    try { parent.postMessage(message, parentOrigin) } catch { /* parent gone */ }
  }
  function postFailed(error) {
    post({ type: 'pdfcraft:failed', error: String(error == null ? 'unknown error' : error).slice(0, 500) })
  }

  var overlay = document.getElementById('pc-overlay')
  function showOverlay(text) { overlay.textContent = text; overlay.hidden = false }
  function hideOverlay() { overlay.hidden = true }

  // ── viewer assembly ──────────────────────────────────────────────────
  var eventBus = new EventBus()
  var linkService = new PDFLinkService({ eventBus })
  var findController = new PDFFindController({ eventBus, linkService })
  var container = document.getElementById('pc-container')
  var viewer = new PDFViewer({
    container: container,
    viewer: document.getElementById('pc-viewer'),
    eventBus: eventBus,
    linkService: linkService,
    findController: findController,
    textLayerMode: 2, // selectable text layer
  })
  linkService.setViewer(viewer)

  var currentDoc = null
  var openSeq = 0 // guards stale async loads

  function teardownDocument() {
    try { viewer.setDocument(null) } catch { /* already cleared */ }
    try { linkService.setDocument(null) } catch { /* already cleared */ }
    try { findController.setDocument(null) } catch { /* already cleared */ }
    if (currentDoc !== null) {
      var doc = currentDoc
      currentDoc = null
      try { doc.destroy() } catch { /* best effort */ }
    }
  }

  function openDocument(name, bytes) {
    var seq = ++openSeq
    var copy = bytes instanceof ArrayBuffer ? bytes.slice(0) : new Uint8Array(bytes).slice().buffer
    var task = pdfjsLib.getDocument({ data: copy })
    task.promise.then(function (doc) {
      if (seq !== openSeq) { try { doc.destroy() } catch { /* stale */ } return }
      teardownDocument()
      currentDoc = doc
      linkService.setDocument(doc)
      findController.setDocument(doc)
      viewer.setDocument(doc)
      // Narrow-panel friendly default. Applied on pagesinit — page geometry
      // is unknown before it, and an earlier currentScaleValue write is
      // silently ignored. The scalechange event reports the result back.
      var onPagesInit = function () {
        eventBus.off('pagesinit', onPagesInit)
        viewer.currentScaleValue = 'page-width'
      }
      eventBus.on('pagesinit', onPagesInit)
      hideOverlay()
      post({ type: 'pdfcraft:loaded', pages: doc.numPages, name: name })
    }, function (error) {
      if (seq !== openSeq) return
      var message = (error && (error.name + ': ' + error.message)) || String(error)
      showOverlay(message)
      postFailed('open failed: ' + message)
    })
  }

  // ── viewer events → parent ───────────────────────────────────────────
  // pdf.js v6 event names: 'pagechanging' (current page moved) and
  // 'scalechanging' (zoom changed) — 'pagechange'/'scalechange' do not exist.
  eventBus.on('pagechanging', function (event) {
    post({ type: 'pdfcraft:page', page: event.pageNumber, pages: currentDoc !== null ? currentDoc.numPages : 0 })
  })
  eventBus.on('scalechanging', function (event) {
    if (typeof event.scale === 'number' && Number.isFinite(event.scale)) {
      post({ type: 'pdfcraft:scale', scale: event.scale })
    }
  })
  eventBus.on('updatefindmatchescount', function (event) {
    var count = (event && event.matchesCount) || {}
    post({ type: 'pdfcraft:findresult', matches: count.total || 0, current: count.current || 0 })
  })
  eventBus.on('updatefindcontrolstate', function (event) {
    var count = (event && event.matchesCount) || {}
    post({ type: 'pdfcraft:findresult', matches: count.total || 0, current: count.current || 0 })
  })

  // ── commands ─────────────────────────────────────────────────────────
  var ZOOM_STEP = 1.15
  var MIN_SCALE = 0.25
  var MAX_SCALE = 8

  function runZoom(mode) {
    if (currentDoc === null) return
    if (mode === 'in') {
      viewer.currentScale = Math.min(MAX_SCALE, viewer.currentScale * ZOOM_STEP)
    } else if (mode === 'out') {
      viewer.currentScale = Math.max(MIN_SCALE, viewer.currentScale / ZOOM_STEP)
    } else if (mode === 'width') {
      viewer.currentScaleValue = 'page-width'
    } else if (mode === 'page') {
      viewer.currentScaleValue = 'page-fit'
    } else if (mode === 'actual') {
      viewer.currentScaleValue = 'page-actual'
    }
  }

  function runFind(query, again, previous) {
    if (currentDoc === null || typeof query !== 'string' || query === '') return
    // pdf.js v6 dropped PDFFindController#executeCommand: the find bar drives
    // the controller through eventBus 'find' events, where state.type ''
    // starts a search and 'again' steps through matches.
    eventBus.dispatch('find', {
      source: window,
      type: again === true ? 'again' : '',
      query: query,
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous === true,
    })
  }

  // ── inbound ──────────────────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return
    if (event.origin !== parentOrigin) return
    var data = event.data
    if (typeof data !== 'object' || data === null) return
    var type = typeof data.type === 'string' ? data.type : ''
    if (type === 'pdfcraft:open') {
      var bytes = data.bytes
      if (!(bytes instanceof ArrayBuffer) && !(bytes instanceof Uint8Array)) {
        postFailed('open without bytes')
        return
      }
      hideOverlay()
      openDocument(typeof data.name === 'string' ? data.name : '', bytes)
      return
    }
    if (currentDoc === null && type !== 'pdfcraft:focusfind') return
    if (type === 'pdfcraft:goto') {
      var page = Number(data.page)
      if (Number.isSafeInteger(page) && page >= 1 && page <= currentDoc.numPages) {
        viewer.currentPageNumber = page
      }
      return
    }
    if (type === 'pdfcraft:zoom') {
      runZoom(data.mode)
      return
    }
    if (type === 'pdfcraft:find') {
      runFind(data.query, data.again === true, data.previous === true)
      return
    }
    if (type === 'pdfcraft:focusfind') {
      post({ type: 'pdfcraft:focusfind' })
      return
    }
  })

  // ── keyboard: Ctrl+F hands off to the panel's search box; +/- zoom ───
  window.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'f' || event.key === 'F')) {
      event.preventDefault()
      post({ type: 'pdfcraft:focusfind' })
      return
    }
    if (currentDoc === null) return
    if ((event.key === '+' || event.key === '=') && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      runZoom('in')
    } else if (event.key === '-' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      runZoom('out')
    }
  })

  // ── top-level failure reporting ──────────────────────────────────────
  window.addEventListener('error', function (event) {
    postFailed(event && event.message ? event.message : 'page error')
  })

  // The components construct synchronously; the panel may open immediately.
  post({ type: 'pdfcraft:ready', version: String(pdfjsLib.version || 'unknown') })

  // Debug handle for end-to-end verification (reads only; not a public API).
  try {
    window.__pc = {
      get viewer() { return viewer },
      get doc() { return currentDoc },
      get findController() { return findController },
    }
  } catch { /* ignore */ }
})()
