/**
 * PdfCraft reader panel — the `sidebar.right.pane.tab` keyed slot body
 * (right-sidebar tab for the `pdfcraft` kind).
 *
 * Composition: a session/file row (session scope, file picker, current file,
 * reveal) above a document row (page nav, zoom, find, download) above a
 * same-origin iframe running the committed bridge page (app/app.html) with
 * the official PDF.js viewer components. All document traffic flows through
 * the `pdfcraft:*` postMessage bridge: the panel sends `pdfcraft:open` with
 * bytes read via remote.workspaceFiles, and the viewer reports page/zoom/find
 * state back. The tab's `keepMounted` keeps the iframe (and its rendered
 * document) alive across tab switches and sidebar collapse.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { appUrl, formatBytes, listPdfs } from './api.ts'
import { parseSessionFileAddress } from './address.ts'
import { isInbound, sendFind, sendGoto, sendOpen, sendZoom } from './bridge.ts'
import type { SessionFileTarget } from './address.ts'
import type { WorkspaceFileEntry } from './api.ts'
import type { PdfcraftInbound, PendingOpen, PdfcraftZoomMode } from './bridge.ts'

/** Localized keys (shape of the zh dictionary). */
export type LocaleKey = keyof import('./locales.ts').zh

/** The slice of the seat's per-tab hook context the body reads. */
export interface TabInfoLike {
  tab: {
    /** Resource address for file tabs; an opaque id (or empty) for the guide-opened page tab. */
    contentId?: string
    /** Bumped when the same tab is navigated again (file re-opened after regeneration). */
    navigation?: { revision?: number }
    /** Tab occurrence lifetime; aborts in-flight reads when the tab closes. */
    signal?: AbortSignal
  }
}

/** Injected face + framework props the panel receives. */
export interface PdfPanelProps {
  t: (key: LocaleKey) => string
  /** Bound `hooks.sessionList` source → selector hook over SessionListState. */
  useSessionList: (selector: (state: any) => any) => any
  /** Standard kit hook from the `sidebar.right.pane.tab` seat (per-tab context). */
  useTabInfo: () => TabInfoLike
  listPdfs: (sessionId: string, signal?: AbortSignal) => Promise<{ files: WorkspaceFileEntry[], truncated: boolean }>
  readFileBytes: (sessionId: string, path: string, signal?: AbortSignal) => Promise<Uint8Array>
  revealFile: (sessionId: string, path: string) => Promise<void>
  staticUrl: string
}

interface SessionRow {
  id: string
  displayTitle: string
  cwd?: string
  retainedBy?: { mainView?: number }
}

interface CurrentFile {
  sessionId: string
  path: string
  name: string
}

function hostBasename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

export function PdfPanel(props: PdfPanelProps) {
  const { t, useSessionList, useTabInfo, listPdfs, readFileBytes, revealFile, staticUrl } = props

  // Per-tab context from the seat. Presence is fixed per mounted instance
  // (the seat always provides it), so the conditional call keeps hook order
  // stable even where the component is rendered outside the seat.
  const tabInfo = useTabInfo !== undefined ? useTabInfo() : undefined
  const tabContentId = tabInfo?.tab?.contentId
  const tabRevision = tabInfo?.tab?.navigation?.revision
  const tabSignal = tabInfo?.tab?.signal

  const sessions = (useSessionList((state: any) => state) ?? { ids: [], byId: {} }) as {
    ids: string[]
    byId: Record<string, SessionRow | undefined>
  }

  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [iframeKey, setIframeKey] = useState(0)
  const [ready, setReady] = useState(false)
  const [staticOk, setStaticOk] = useState<boolean | null>(null)

  const [scopeChoice, setScopeChoice] = useState<string | null>(null)
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([])
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'done'>('idle')
  const [scanHint, setScanHint] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const [current, setCurrent] = useState<CurrentFile | null>(null)
  const [opening, setOpening] = useState(false)
  const [page, setPage] = useState(0)
  const [pages, setPages] = useState(0)
  const [scale, setScale] = useState(0)
  const [findState, setFindState] = useState<{ matches: number, current: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const searchRef = useRef<HTMLInputElement | null>(null)
  const [searchText, setSearchText] = useState('')
  const lastQueryRef = useRef('')
  const [pageInput, setPageInput] = useState('1')

  // Latest-current ref so the message listener never holds a stale closure.
  const currentRef = useRef<CurrentFile | null>(null)
  currentRef.current = current
  const readFileBytesRef = useRef(readFileBytes)
  readFileBytesRef.current = readFileBytes
  // Open requests that arrived before the app's ready message: flushed on ready.
  const pendingOpenRef = useRef<PendingOpen | null>(null)
  const readyRef = useRef(ready)
  readyRef.current = ready
  const tabSignalRef = useRef<AbortSignal | undefined>(undefined)
  tabSignalRef.current = tabSignal
  // Monotonic load sequence: stale reads (superseded or tab closed) drop out.
  const loadSeqRef = useRef(0)

  const candidateRows: SessionRow[] = useMemo(() => {
    const rows: SessionRow[] = []
    for (const id of sessions.ids ?? []) {
      const row = sessions.byId?.[id]
      if (row?.cwd) rows.push(row)
    }
    return rows
  }, [sessions])

  const mainViewId = useMemo(
    () => candidateRows.find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id,
    [candidateRows],
  )
  const scopeId = scopeChoice ?? mainViewId ?? candidateRows[0]?.id

  // The file this tab was opened for (a clicked card / mention / @file /
  // Files row); undefined on the guide-opened blank page tab.
  const target = useMemo(() => parseSessionFileAddress(tabContentId), [tabContentId])

  // True when a newer load superseded this one or the tab's lifetime ended.
  const signalGone = (seq: number) =>
    seq !== loadSeqRef.current || (tabSignalRef.current?.aborted ?? false)

  // Load the tab's file straight into the viewer, through the address's own
  // session (independent of the scope selector, which is pinned to match).
  const loadTarget = useCallback(async (file: SessionFileTarget) => {
    const seq = ++loadSeqRef.current
    try {
      setScopeChoice(file.sessionId)
      setOpening(true)
      const bytes = await readFileBytes(file.sessionId, file.path, tabSignalRef.current)
      if (signalGone(seq)) return
      const win = iframeRef.current?.contentWindow ?? null
      if (readyRef.current && win !== null) {
        sendOpen(win, file.name, bytes)
      } else {
        // The viewer's bridge drops opens that arrive before its ready message.
        pendingOpenRef.current = { name: file.name, bytes }
      }
      setCurrent({ sessionId: file.sessionId, path: file.path, name: file.name })
      setFindState(null)
      setError(null)
      setNotice(null)
    } catch (openError) {
      if (signalGone(seq)) return
      setOpening(false)
      const code = String((openError as Error & { code?: string })?.code ?? '')
      setError(code.includes('too-large')
        ? t('fileTooLarge')
        : `${t('openFailed')}: ${(openError as Error)?.message ?? String(openError)}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readFileBytes])
  const loadTargetRef = useRef(loadTarget)
  loadTargetRef.current = loadTarget

  // Reload on re-navigation (revision bump): the same file re-opened after
  // regeneration refreshes in place instead of showing stale bytes.
  useEffect(() => {
    if (target === undefined || target.path === '') return
    void loadTargetRef.current(target)
  }, [target, tabRevision])

  // One static-build availability probe: drives the setup hint vs the iframe.
  useEffect(() => {
    const controller = new AbortController()
    fetch(staticUrl, { signal: controller.signal })
      .then(response => setStaticOk(response.ok))
      .catch(() => { if (!controller.signal.aborted) setStaticOk(false) })
    return () => controller.abort()
  }, [staticUrl])

  const scan = useCallback(async (sessionId: string, signal?: AbortSignal) => {
    setScanState('scanning')
    setScanHint(null)
    try {
      const result = await listPdfs(sessionId, signal)
      if (signal?.aborted) return
      setFiles(result.files)
      setScanState('done')
      if (result.truncated) setScanHint(t('listTruncated'))
    } catch (scanError) {
      if (signal?.aborted) return
      setFiles([])
      setScanState('done')
      setScanHint(`${t('scanFailed')}: ${(scanError as Error)?.message ?? String(scanError)}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listPdfs, t])

  // Open the picker → scan; rescan when the scope changes while open.
  useEffect(() => {
    if (!pickerOpen || !scopeId) return
    const controller = new AbortController()
    void scan(scopeId, controller.signal)
    return () => controller.abort()
  }, [pickerOpen, scopeId, scan])

  // Status notices settle on their own.
  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // Keep the page input in sync with the viewer's reported page.
  useEffect(() => {
    if (page > 0) setPageInput(String(page))
  }, [page])

  const openFile = useCallback(async (entry: WorkspaceFileEntry) => {
    if (!scopeId) return
    const seq = ++loadSeqRef.current
    try {
      setOpening(true)
      const bytes = await readFileBytes(scopeId, entry.path)
      if (seq !== loadSeqRef.current) return
      const win = iframeRef.current?.contentWindow ?? null
      if (readyRef.current && win !== null) {
        sendOpen(win, entry.name, bytes)
      } else {
        pendingOpenRef.current = { name: entry.name, bytes }
      }
      setCurrent({ sessionId: scopeId, path: entry.path, name: entry.name })
      setPickerOpen(false)
      setFindState(null)
      setError(null)
      setNotice(null)
    } catch (openError) {
      if (seq !== loadSeqRef.current) return
      setOpening(false)
      const code = String((openError as Error & { code?: string })?.code ?? '')
      const detail = code.includes('too-large')
        ? t('fileTooLarge')
        : `${t('openFailed')}: ${(openError as Error)?.message ?? String(openError)}`
      setError(detail)
    }
  }, [scopeId, readFileBytes, t])

  const revealCurrent = useCallback(async () => {
    const active = currentRef.current
    if (active === null) return
    try {
      await revealFile(active.sessionId, active.path)
    } catch (revealError) {
      setError(`${t('revealFailed')}: ${(revealError as Error)?.message ?? String(revealError)}`)
    }
  }, [revealFile, t])

  const downloadCurrent = useCallback(async () => {
    const active = currentRef.current
    if (active === null) return
    try {
      const bytes = await readFileBytesRef.current(active.sessionId, active.path)
      // Fresh read: the open bytes were cloned into the iframe, not kept.
      const blob = new Blob([bytes.slice().buffer], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = active.name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setNotice(`${t('downloaded')} · ${formatBytes(bytes.length)}`)
    } catch (downloadError) {
      setError(`${t('downloadFailed')}: ${(downloadError as Error)?.message ?? String(downloadError)}`)
    }
  }, [t])

  const commitPage = useCallback(() => {
    const wanted = Number.parseInt(pageInput, 10)
    if (Number.isSafeInteger(wanted) && wanted >= 1 && (pages === 0 || wanted <= pages)) {
      sendGoto(iframeRef.current?.contentWindow ?? null, wanted)
    } else {
      setPageInput(page > 0 ? String(page) : '1')
    }
  }, [pageInput, page, pages])

  const runZoom = useCallback((mode: PdfcraftZoomMode) => {
    sendZoom(iframeRef.current?.contentWindow ?? null, mode)
  }, [])

  const onSearchKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const query = searchText.trim()
    if (query === '') return
    // Same query again → step through matches; Shift reverses direction.
    const again = lastQueryRef.current === query
    sendFind(iframeRef.current?.contentWindow ?? null, query, again, event.shiftKey)
    lastQueryRef.current = query
  }, [searchText])

  // The bridge: only messages from our iframe, only pdfcraft: types.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      if (!isInbound(event.data)) return
      const message = event.data as PdfcraftInbound
      switch (message.type) {
        case 'pdfcraft:ready':
          setReady(true)
          setError(null)
          if (pendingOpenRef.current !== null) {
            const pending = pendingOpenRef.current
            pendingOpenRef.current = null
            sendOpen(iframeRef.current?.contentWindow ?? null, pending.name, pending.bytes)
          }
          break
        case 'pdfcraft:loaded':
          setOpening(false)
          setPages(message.pages)
          setFindState(null)
          setError(null)
          break
        case 'pdfcraft:page':
          setPage(message.page)
          setPages(message.pages)
          break
        case 'pdfcraft:scale':
          setScale(message.scale)
          break
        case 'pdfcraft:findresult':
          setFindState({ matches: message.matches, current: message.current })
          break
        case 'pdfcraft:focusfind':
          searchRef.current?.focus()
          searchRef.current?.select()
          break
        case 'pdfcraft:failed':
          setOpening(false)
          setError(`${t('loadFailed')}: ${message.error ?? ''}`)
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [t])

  const statusLine = error ?? notice
  const statusKind = error !== null ? 'error' : 'ok'
  const percent = scale > 0 ? `${Math.round(scale * 100)}%` : '—'

  if (staticOk === false) {
    return <div className="dsh-pc-root"><div className="dsh-pc-setup">{t('setupMissing')}</div></div>
  }

  return (
    <div className="dsh-pc-root">
      <div className="dsh-pc-toolbar">
        <label className="dsh-pc-field">
          <span className="dsh-pc-field-label">{t('sessionScope')}</span>
          <select
            className="dsh-pc-select"
            value={scopeId ?? ''}
            onChange={event => { setScopeChoice(event.target.value === '' ? null : event.target.value) }}
          >
            {candidateRows.length === 0 && <option value="">{t('noSession')}</option>}
            {candidateRows.map(row => (
              <option key={row.id} value={row.id}>
                {row.displayTitle} · {hostBasename(row.cwd ?? '')}
              </option>
            ))}
          </select>
        </label>

        <div className="dsh-pc-picker-wrap">
          <button
            type="button"
            className="dsh-pc-btn"
            disabled={scopeId === undefined}
            onClick={() => setPickerOpen(open => !open)}
            title={t('openTitle')}
          >
            {t('open')} {pickerOpen ? '▾' : '▸'}
          </button>
          {pickerOpen && (
            <div className="dsh-pc-picker" role="menu">
              <div className="dsh-pc-picker-head">
                <span>{scanState === 'scanning' ? t('scanning') : `${files.length}`}</span>
                <button type="button" className="dsh-pc-btn dsh-pc-btn-small" onClick={() => scopeId && void scan(scopeId, undefined)}>
                  {t('refresh')}
                </button>
              </div>
              {scanHint !== null && <div className="dsh-pc-picker-hint">{scanHint}</div>}
              {scanState === 'done' && files.length === 0 && (
                <div className="dsh-pc-picker-empty">{t('noFiles')}</div>
              )}
              <div className="dsh-pc-picker-list">
                {files.map(entry => (
                  <button
                    key={entry.path}
                    type="button"
                    className={`dsh-pc-picker-item${current?.path === entry.path && current?.sessionId === scopeId ? ' is-active' : ''}`}
                    onClick={() => void openFile(entry)}
                    title={entry.path}
                  >
                    <span className="dsh-pc-picker-name">{entry.name}</span>
                    <span className="dsh-pc-picker-path">{entry.path}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <span className="dsh-pc-file" title={current !== null ? current.path : undefined}>
          {current !== null
            ? (
              <>
                <span className={`dsh-pc-dot${opening ? ' is-busy' : ''}`} />
                {current.name}
              </>
            )
            : <span className="dsh-pc-file-none">—</span>}
        </span>

        <span className="dsh-pc-spacer" />

        {current !== null && (
          <button type="button" className="dsh-pc-btn" onClick={() => void revealCurrent()} title={t('reveal')}>
            {t('reveal')}
          </button>
        )}
      </div>

      <div className="dsh-pc-navbar">
        <button
          type="button"
          className="dsh-pc-btn dsh-pc-btn-icon"
          disabled={pages === 0 || page <= 1}
          onClick={() => sendGoto(iframeRef.current?.contentWindow ?? null, Math.max(1, page - 1))}
          title={t('prevPage')}
        >‹</button>
        <input
          className="dsh-pc-page-input"
          value={pageInput}
          disabled={pages === 0}
          title={t('gotoPage')}
          onChange={event => setPageInput(event.target.value.replace(/[^\d]/g, ''))}
          onBlur={() => commitPage()}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); commitPage() }
          }}
        />
        <span className="dsh-pc-page-total">/ {pages > 0 ? pages : '—'} {t('pageOf')}</span>
        <button
          type="button"
          className="dsh-pc-btn dsh-pc-btn-icon"
          disabled={pages === 0 || page >= pages}
          onClick={() => sendGoto(iframeRef.current?.contentWindow ?? null, Math.min(pages, page + 1))}
          title={t('nextPage')}
        >›</button>

        <span className="dsh-pc-divider" />

        <button type="button" className="dsh-pc-btn dsh-pc-btn-icon" disabled={pages === 0} onClick={() => runZoom('out')} title={t('zoomOut')}>−</button>
        <span className="dsh-pc-scale" title={`${t('zoomActual')}: 100%`}>{percent}</span>
        <button type="button" className="dsh-pc-btn dsh-pc-btn-icon" disabled={pages === 0} onClick={() => runZoom('in')} title={t('zoomIn')}>+</button>
        <button type="button" className="dsh-pc-btn" disabled={pages === 0} onClick={() => runZoom('width')} title={t('fitWidth')}>{t('fitWidth')}</button>
        <button type="button" className="dsh-pc-btn" disabled={pages === 0} onClick={() => runZoom('page')} title={t('fitPage')}>{t('fitPage')}</button>
        <button type="button" className="dsh-pc-btn dsh-pc-btn-icon" disabled={pages === 0} onClick={() => runZoom('actual')} title={t('zoomActual')}>1:1</button>

        <span className="dsh-pc-divider" />

        <input
          ref={searchRef}
          className="dsh-pc-input"
          value={searchText}
          disabled={pages === 0}
          placeholder={t('searchPlaceholder')}
          title={t('search')}
          onChange={event => setSearchText(event.target.value)}
          onKeyDown={onSearchKeyDown}
        />
        {findState !== null && (
          <span className={`dsh-pc-find-count${findState.matches === 0 ? ' is-empty' : ''}`}>
            {findState.matches === 0 ? t('searchNone') : `${findState.current}/${findState.matches}`}
          </span>
        )}

        <span className="dsh-pc-spacer" />

        {current !== null && (
          <button type="button" className="dsh-pc-btn" onClick={() => void downloadCurrent()} title={t('download')}>
            {t('download')}
          </button>
        )}
      </div>

      {statusLine !== null && (
        <button
          type="button"
          className={`dsh-pc-status dsh-pc-status-${statusKind}`}
          onClick={() => { setError(null); setNotice(null) }}
        >
          {statusLine}
        </button>
      )}

      <div className="dsh-pc-frame-wrap">
        {staticOk !== false && (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            className="dsh-pc-frame"
            src={staticUrl}
            title={t('panelTitle')}
            allow="clipboard-read; clipboard-write"
          />
        )}
        {!ready && staticOk !== false && (
          <div className="dsh-pc-loading">{t('loading')}</div>
        )}
        {ready && current === null && (
          <div className="dsh-pc-empty">{t('emptyHint')}</div>
        )}
        {opening && (
          <div className="dsh-pc-loading">{t('opening')}</div>
        )}
      </div>
    </div>
  )
}
