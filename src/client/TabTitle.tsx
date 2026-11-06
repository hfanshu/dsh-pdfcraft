/**
 * Live tab-chip title for the pdfcraft right-sidebar tab.
 *
 * Resource tabs (a clicked file card / mention / @file / Files row) show the
 * file name; the guide-opened blank page tab shows the localized type label —
 * without this seat the chip keeps the text captured at open time, so a page
 * tab would not follow locale changes. The icon rides currentColor.
 */
import { parseSessionFileAddress } from './address.ts'
import type { TabInfoLike } from './PdfPanel.tsx'
import type { LocaleKey } from './PdfPanel.tsx'
import { PanelIcon } from './PanelIcon.tsx'

export interface TabTitleProps {
  t: (key: LocaleKey) => string
  /** Standard kit hook from the `sidebar.right.pane.tab.title` seat. */
  useTabInfo?: () => TabInfoLike
}

export function TabTitle({ t, useTabInfo }: TabTitleProps) {
  // Presence is fixed per mounted instance, so the conditional call keeps
  // hook order stable even outside the seat.
  const tabInfo = useTabInfo !== undefined ? useTabInfo() : undefined
  const target = parseSessionFileAddress(tabInfo?.tab?.contentId)
  const label = target !== undefined && target.name !== '' ? target.name : t('tabTitle')
  return (
    <>
      <PanelIcon size={12} className="dsh-pc-tab-title-icon" />
      <span>{label}</span>
    </>
  )
}
