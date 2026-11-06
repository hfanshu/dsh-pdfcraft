/** Decorative document-page glyph for the sidebar panel row (no host primitive deps). */
export function PanelIcon({ size, className }: { size?: number, className?: string } = {}) {
  const edge = size ?? 16
  return (
    <svg width={edge} height={edge} viewBox="0 0 48 48" fill="none" aria-hidden="true" className={className}>
      <path d="M10 5h19l9 9v29a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" fill="currentColor" opacity="0.9" />
      <path d="M29 5l9 9h-9V5z" fill="var(--dsw-alias-surface-default, #fff)" opacity="0.7" />
      <rect x="14" y="19" width="20" height="3" rx="1.5" fill="var(--dsw-alias-surface-default, #fff)" opacity="0.9" />
      <rect x="14" y="26" width="20" height="3" rx="1.5" fill="var(--dsw-alias-surface-default, #fff)" opacity="0.9" />
      <rect x="14" y="33" width="14" height="3" rx="1.5" fill="var(--dsw-alias-surface-default, #fff)" opacity="0.9" />
    </svg>
  )
}
