/** Shared types for the dsh-pdfcraft host half. */

/** Plugin configuration (the `Config` schema → plugins settings page). */
export interface PdfcraftConfig {
  enabled?: boolean
  /** Open PDF files in PdfCraft by default; off = built-in preview. */
  defaultOpener?: boolean
}

/** Standard JSON API envelope, aligned with the other dsh plugins. */
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}
