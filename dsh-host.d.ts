/**
 * Minimal ambient declarations for the DSH host services used by dsh-pdfcraft.
 * Same posture as dsh-gridcraft's dsh-host.d.ts (byte-identical apart from the
 * plugin name): the desktop bundle ships no lib/types, so the surfaces are
 * declared here from the upstream sources (packages/fs,
 * packages/api/workspace-files, dsh-kanban proven usage).
 *
 * @deepseek-ai/cordis is declared as a self-contained module so the plugin
 * type-checks without installing the private packages.
 */

declare module '@deepseek-ai/cordis' {
  /** Cordis host context (the subset dsh-pdfcraft uses). */
  export interface Context {
    webServer: PcWebServerService
    /** Host Session registry — resolves a Session's workspace root. */
    sessions: PcSessionsService
    /** Host session event query (presents coordinates → presented file), guarded by ctx.inject. */
    sessionQuery?: PcSessionQueryService
    /** Register a fiber-scoped cleanup effect. */
    effect(execute: () => () => void, label?: string): () => void
    /** Run once the named services exist; the callback's derived context carries the injected services. */
    inject(services: string[], callback: (serviceCtx: Context) => void): () => void
  }
}

declare module '@deepseek-ai/dsh-host-webserver' {
  import type { IncomingMessage, ServerResponse } from 'node:http'

  export interface WebServerRoute {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }

  export interface WebServerService {
    /** Register a named exact/prefix HTTP route; returns a disposer. */
    register(route: WebServerRoute): () => void
    /** Currently bound port (0 = OS-assigned before listen). */
    readonly port: number
  }
}

/** Host sessions service (`ctx.sessions`) — the subset routes.ts reads. */
interface PcSessionsService {
  /**
   * Live Session registry. Returns `undefined` for unknown identities; the
   * header carries the Session's workspace cwd (see workspace-files's
   * workspaceFileScope lookup, which this plugin mirrors for reveals).
   */
  get(sessionId: string): { header?: { cwd?: string } } | undefined
}

/** Host sessionQuery service (`ctx.sessionQuery`) — the subset the resolve route reads. */
interface PcSessionQueryService {
  /**
   * Read one durable Session event at its coordinates. `target.type` is the
   * event type (`deliverables/presented` for file declarations) with the
   * decoded event payload in `target.data`.
   */
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

/** WebServer service shape on Context (module augmentation target). */
interface PcWebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
  }): () => void
  readonly port: number
}
