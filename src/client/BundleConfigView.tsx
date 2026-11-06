/**
 * The default-opener switch rendered on the plugin's own detail page
 * (`plugins.bundle.config`, keyed by the bundle's package name — the slot the
 * Plugins page renders between the description and the rows when a bundle
 * contributes it).
 *
 * The form is the plugin entry's ConfigForm (`configForms.get('pdfcraft')`),
 * supplied by the apply face. A toggle writes immediately — one boolean, no
 * staging — and the field is `.volatile()`, so the write lands live.
 *
 * `Switch` comes from the host's ui-primitives platform module (shared React
 * tree, same control the Plugins page itself renders).
 */
import { useSyncExternalStore } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LocaleKey } from './PdfPanel.tsx'

/** The slice of ConfigForm the view needs (any-typed like the rest of the client). */
export interface OpenerFormLike {
  getSnapshot(): { status: string, value?: { defaultOpener?: boolean } }
  subscribe(listener: () => void): () => void
  mutate(ops: ReadonlyArray<{ op: 'set' | 'unset', path: readonly string[], value?: unknown }>): Promise<boolean>
}

export interface BundleConfigViewProps {
  t: (key: LocaleKey) => string
  /** The page asks `summary` for one-liners and `page` for the form. */
  view: 'summary' | 'page'
  form: OpenerFormLike
}

export function BundleConfigView({ t, view, form }: BundleConfigViewProps) {
  // The subscribe reference must not lose its `this` — pass a wrapper, not
  // the bare method (an unbound controller method throws at render and the
  // slot machinery abdicates the entry, leaving the section empty).
  const subscribe = (listener: () => void) => form.subscribe(listener)
  const enabled = useSyncExternalStore(subscribe, () => {
    const snapshot = form.getSnapshot()
    // loading/unavailable, or the field unset: the schema default (on).
    return snapshot.status !== 'ready' || snapshot.value?.defaultOpener !== false
  })

  if (view === 'summary') return null
  return (
    <div className="dsh-pc-setting-row">
      <div className="dsh-pc-setting-text">
        <div className="dsh-pc-setting-title">{t('configTitle')}</div>
        <div className="dsh-pc-setting-desc">{t('configDescription')}</div>
      </div>
      <Switch
        checked={enabled}
        label={t('configTitle')}
        onChange={next => {
          void form.mutate([{ op: 'set', path: ['defaultOpener'], value: next }])
        }}
      />
    </div>
  )
}
