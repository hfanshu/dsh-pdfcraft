/**
 * Local parser for session-scoped file resource addresses.
 *
 * The host builds `dsh-resource://file/session/<sessionId>/<path>` addresses
 * with per-segment `encodeURIComponent` (`@deepseek-ai/dsh-util-workspace-path`
 * on the host side). The plugin bundle cannot import that module (the client
 * loader only provides the platform baseline), so the tiny read-side grammar
 * lives here: enough to turn a tab's `contentId` back into
 * (sessionId, path, name) for the viewer bridge.
 */

/** Scheme prefix of a session-scoped file resource address. */
const SESSION_PREFIX = 'dsh-resource://file/session/'

/** Encode one address path segment (the host grammar keeps '/' as separators). */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment)
}

/**
 * Build a session-scoped file resource address — the read-side mirror of the
 * host's `sessionFileAddress` grammar: per-segment `encodeURIComponent`,
 * backslashes normalized to `/`, and a workspace-external absolute path
 * (`/abs/...`) kept as the leading empty marker segment the parser restores.
 */
export function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const encoded = normalized.split('/').map(encodeSegment).join('/')
  return `${SESSION_PREFIX}${encodeSegment(sessionId)}/${encoded}`
}

/** One decoded address: owning session, workspace-relative (or absolute) path, display name. */
export interface SessionFileTarget {
  sessionId: string
  path: string
  name: string
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

/**
 * Parse `dsh-resource://file/session/<sessionId>/<path...>` into its parts.
 * The path may be workspace-relative or workspace-absolute — the latter is
 * marked by a leading empty segment (`.../session/s1//elsewhere/a.pdf`),
 * which must survive as a leading `/`. Returns `undefined` for absolute-scope
 * addresses, malformed input, or anything that is not a file address at all —
 * callers treat that as "not a workspace file tab" (e.g. the guide-opened
 * page tab).
 */
export function parseSessionFileAddress(address: string | undefined | null): SessionFileTarget | undefined {
  if (typeof address !== 'string' || !address.startsWith(SESSION_PREFIX)) return undefined
  const raw = address.slice(SESSION_PREFIX.length).split(/[?#]/, 1)[0]
  const segments = raw.split('/')
  if (segments.length < 2) return undefined
  const sessionId = decodeSegment(segments[0])
  if (sessionId === undefined || sessionId === '') return undefined
  // An empty first path segment is the host's marker for a workspace-external
  // absolute path (leading `/`); keep it so the host resolver sees the same
  // path. A trailing slash alone (`.../session/s1/`) is the empty root path.
  const absolute = segments[1] === '' && segments.length > 2
  const decoded: string[] = []
  for (const segment of absolute ? segments.slice(2) : segments.slice(1)) {
    const part = decodeSegment(segment)
    if (part === undefined) return undefined
    decoded.push(part)
  }
  const path = (absolute ? '/' : '') + decoded.join('/')
  const name = decoded[decoded.length - 1] ?? ''
  return { sessionId, path, name }
}
