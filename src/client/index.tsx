/**
 * dsh-pdfcraft client entry — registers the PDF reader as a right-sidebar tab
 * type (the two-stage sidebar-right registration, as its siblings
 * dsh-gridcraft / dsh-wordcraft do):
 *
 * - Stage 1 (`ctx.sidebarRightTabs.register`): the tab type — kind, chip
 *   title, and the guide-page entry card that opens it as a blank page tab.
 *   Resource `patterns` additionally claim session-scope PDF file addresses
 *   (`.pdf`), so file cards, chat mentions, @file references and Files-sidebar
 *   rows route here instead of the fallback text preview (this type's default
 *   `extension` band outranks it).
 * - Stage 2 (`sidebar.right.pane.tab` keyed slot): the tab body, dispatched
 *   under the stage-1 `id` — one instance per tab (blank page or file).
 *   `sidebar.right.pane.tab.title` adds a live chip title (file name for
 *   resource tabs; the captured-at-open default would not follow locale
 *   changes for the page tab).
 * - Also contributed: an "Open in PDF Reader" button on conversation file
 *   cards (`deliverables.file.actions` slot) for PDF files.
 *
 * `keepMounted` keeps the iframe and its rendered document alive across tab
 * switches, sidebar collapse, and session changes.
 */
import { appUrl, listPdfs } from './api.ts'
import { parseSessionFileAddress, sessionFileAddress } from './address.ts'
import type { SessionFileTarget } from './address.ts'
import { dictionaries, NS } from './locales.ts'
import { PdfPanel } from './PdfPanel.tsx'
import { TabTitle } from './TabTitle.tsx'
import { OpenInPdfcraft } from './OpenInPdfcraft.tsx'
import { BundleConfigView } from './BundleConfigView.tsx'
import { PanelIcon } from './PanelIcon.tsx'

/** Inlined by esbuild (define) from src/client/pdfcraft.css. */
declare const __PC_CSS__: string

/** Inlined by esbuild (define) from package.json — the console load marker. */
declare const __PC_VERSION__: string

/** Tab implementation identity — the body/title slot key; the package name is the natural value. */
const TAB_ID = 'dsh-pdfcraft-plugin'

/** This bundle's package name — the `plugins.bundle.config` key on the Plugins page. */
const BUNDLE_ID = 'dsh-pdfcraft-plugin'

/** Profile entry id (cordis.patch.yml) — also the settings namespace the client reads. */
const ENTRY_ID = 'pdfcraft'

/** Tab type discriminator — what `sidebarRight.openTab` names. */
const TAB_KIND = 'pdfcraft'

/** Guide-card position among the shipped entries (gridcraft 60, wordcraft 61). */
const GUIDE_ORDER = 62

/** PDF extensions claimed from the fallback text preview. */
const PDF_PATTERNS = ['*.pdf']

/** Required client services (remote sub-namespaces are declared individually). */
export const inject = ['slots', 'locale', 'configForms', 'sidebarRight', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles', 'remote.session', 'sessions']

/** Idempotent style injection (the factory may run again after HMR-like reloads). */
function injectStyles(): void {
  const id = 'dsh-pdfcraft-styles'
  if (document.getElementById(id) !== null) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = __PC_CSS__
  document.head.appendChild(style)
}

export function apply(ctx: any): void {
  try {
    applyImpl(ctx)
  } catch (error) {
    // Boot audits render only the state name for a failed fiber — surface the
    // real error for diagnostics (also visible in the browser console).
    ;(window as any).__DSH_PDFCRAFT_BOOT_ERROR__ = (error as Error)?.stack ?? String(error)
    console.error('[dsh-pdfcraft] client apply failed:', error)
    throw error
  }
}

function applyImpl(ctx: any): void {
  console.info('[dsh-pdfcraft] client bundle v' + __PC_VERSION__)
  injectStyles()
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-pdfcraft: dictionaries')
  const t = ctx.locale.bind(NS)

  // The plugin's own config (plugins settings page → dsh-pdfcraft-plugin):
  // the default-opener switch, read live for every routing decision and card.
  const openerForm = ctx.configForms.get<{ defaultOpener?: boolean }>(ENTRY_ID)
  const isDefaultOpener = (): boolean => {
    const snapshot = openerForm.getSnapshot()
    // loading/unavailable, or the field unset: the schema default (on).
    return snapshot.status !== 'ready' || snapshot.value?.defaultOpener !== false
  }

  // The inject face closes over the client context (services stay in the
  // apply world; the component only receives data + callbacks).
  const face = {
    hooks: {
      // Bare getSnapshot/subscribe source → renderer binds useSessionList.
      sessionList: ctx.sessions.list,
    },
    listPdfs: (sessionId: string, signal?: AbortSignal) =>
      listPdfs(ctx.remote, sessionId, signal),
    readFileBytes: (sessionId: string, path: string, signal?: AbortSignal) =>
      ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
        .then((result: any) => unwrapRemoteData(result)),
    revealFile: (sessionId: string, path: string) =>
      ctx.remote.session.openWorkspacePath({ path }).then((result: any) => unwrapRemoteValue(result)),
    staticUrl: appUrl(),
  }

  // Stage 1: the tab type. Copy thunks re-evaluate per read, so a language
  // change needs no re-registration. Patterns without ':' match the address
  // path by basename at any depth (nocase, dotfiles included).
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    keepMounted: true,
    patterns: PDF_PATTERNS,
    // The plugin-config default-opener switch vetoes here: with it off, the
    // fallback text preview resumes and this type is simply not offered.
    canOpen: (address: string) => isDefaultOpener() && parseSessionFileAddress(address) !== undefined,
    title: (address: string) => {
      const target = parseSessionFileAddress(address)
      return target !== undefined && target.name !== '' ? target.name : t('tabTitle')
    },
    guide: [{
      id: 'open',
      order: GUIDE_ORDER,
      title: () => t('guideTitle'),
      description: () => t('guideDescription'),
      icon: PanelIcon,
    }],
  }), 'dsh-pdfcraft: tab type')

  // Stage 2: the body (keyed by the type id; `locale: NS` keeps the reactive
  // framework t seat on the component props).
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
    locale: NS,
    inject: () => face,
  }, PdfPanel))

  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: TAB_ID,
    locale: NS,
  }, TabTitle))

  // File-card button: resolves the card's presented coordinates to the
  // declared path (cached per actionUrl) and opens matching files here.
  const resolveCache = new Map<string, Promise<SessionFileTarget | null>>()
  const resolvePresented = (actionUrl: string): Promise<SessionFileTarget | null> => {
    const cached = resolveCache.get(actionUrl)
    if (cached !== undefined) return cached
    const query = new URL(actionUrl, window.location.href).searchParams
    const promise = fetch(`/api/dsh-pdfcraft/resolve?${query}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('dsh-auth-token') ?? ''}` },
    })
      .then(async response => (response.ok ? await response.json() as {
        success: boolean
        data?: { sessionId: string, path: string, name: string }
      } : null))
      .then(body => body !== null && body.success && body.data !== undefined
        ? { sessionId: body.data.sessionId, path: body.data.path, name: body.data.name }
        : null)
      .catch(() => null)
    resolveCache.set(actionUrl, promise)
    return promise
  }

  ctx.slots.inject('deliverables.file.actions', () => ctx.slots.register({
    name: 'deliverables.file.actions',
    id: 'pdfcraft-open',
    locale: NS,
    inject: () => ({
      resolvePresented,
      openAddress: (address: string) => { ctx.sidebarRight.openResource(address) },
      isDefaultOpener,
      subscribeDefaultOpener: (listener: () => void) => openerForm.subscribe(listener),
    }),
  }, OpenInPdfcraft))

  // The default-opener switch on the bundle's own Plugins page (keyed by the
  // package name; the page renders it between description and rows).
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: BUNDLE_ID,
    locale: NS,
    inject: () => ({ form: openerForm }),
  }, BundleConfigView))
}

/** Unwrap a readBytes RemoteResult to its bytes. */
function unwrapRemoteData(result: { ok: boolean, value?: { data: Uint8Array }, error?: { code?: string, message?: string } }): Uint8Array {
  if (result.ok && result.value) return result.value.data
  const code = result.error?.code ?? ''
  const message = result.error?.message ?? 'remote failure'
  const error = new Error(code !== '' ? `${code}: ${message}` : message) as Error & { code?: string }
  error.code = code
  throw error
}

/** Unwrap a plain RemoteResult to its value. */
function unwrapRemoteValue(result: { ok: boolean, value?: unknown, error?: { code?: string, message?: string } }): unknown {
  if (result.ok) return result.value
  const code = result.error?.code ?? ''
  const message = result.error?.message ?? 'remote failure'
  const error = new Error(code !== '' ? `${code}: ${message}` : message) as Error & { code?: string }
  error.code = code
  throw error
}
