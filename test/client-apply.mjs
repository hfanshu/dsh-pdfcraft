/**
 * Client-bundle apply test for dsh-pdfcraft (no DSH host, no browser):
 *   node test/client-apply.mjs
 * Loads the wrapped lib/client.js factory with a stubbed __ModuleLoader__ and
 * a recording mock client context, runs apply(), and asserts the slot
 * registrations the plugin must contribute — the plugins-page config section,
 * the sidebar-right tab type/body/title, and the file-card button — plus the
 * service inject list the loader guard enforces.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const nodeRequire = createRequire(join(root, 'package.json'))

// ── browser-ish globals the client touches during apply ───────────────
const storage = new Map()
globalThis.window = globalThis
globalThis.localStorage = {
  getItem: key => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)) },
  removeItem: key => { storage.delete(key) },
}
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', set textContent(value) { this._css = value }, get textContent() { return this._css } }),
  head: { appendChild: () => {} },
}
globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type } }

// ── load the wrapped bundle through a stubbed __ModuleLoader__ ────────
// The bundle only pulls react hooks + the jsx runtime at run time; the
// react-dom and ui-primitives specifiers stay external (PLATFORM_MODULES),
// so bare stubs satisfy them without a DOM.
const requireMap = {
  react: nodeRequire('react'),
  'react/jsx-runtime': nodeRequire('react/jsx-runtime'),
  'react-dom': {},
  'react-dom/client': {},
  '@deepseek-ai/dsh-client-ui-primitives': { Switch: () => null },
}
let loadedDefinition
globalThis.__ModuleLoader__ = { load: definition => { loadedDefinition = definition } }
new Function('window', readFileSync(join(root, 'lib', 'client.js'), 'utf8'))(globalThis.window)
assert.ok(loadedDefinition, 'the bundle registers through __ModuleLoader__')
assert.equal(loadedDefinition.id, 'dsh-pdfcraft-plugin')

const plugin = loadedDefinition.factory(specifier => {
  if (!(specifier in requireMap)) throw new Error(`unexpected require: ${specifier}`)
  return requireMap[specifier]
})
assert.equal(typeof plugin.apply, 'function', 'exports.apply')
assert.ok(Array.isArray(plugin.inject), 'exports.inject survives the wrapper copy')
assert.ok(plugin.inject.includes('configForms'), 'inject declares configForms (the default-opener form)')
assert.ok(plugin.inject.includes('sidebarRightTabs'), 'inject declares sidebarRightTabs')

// ── recording mock client context ─────────────────────────────────────
const registrations = []
const injectCalls = []
const tabTypes = []
const openerForms = new Set()
const openerForm = {
  getSnapshot: () => ({ status: 'ready', value: { defaultOpener: true } }),
  subscribe: () => () => {},
  mutate: async () => true,
}

const ctx = {
  effect: (execute) => {
    const disposer = execute()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  inject: (services, callback) => { callback(); return () => {} },
  locale: {
    register: () => () => {},
    bind: () => key => key,
    getLocale: () => ({ active: 'zh' }),
    subscribe: () => () => {},
  },
  configForms: {
    get: namespace => { openerForms.add(namespace); return openerForm },
  },
  sidebarRightTabs: { register: definition => { tabTypes.push(definition); return () => {} } },
  sidebarRight: { openResource: () => {} },
  remote: {
    workspaceFiles: { readBytes: async () => ({ ok: true, value: { data: new Uint8Array() } }) },
    session: { openWorkspacePath: async () => ({ ok: true, value: {} }) },
  },
  sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } },
  slots: {
    inject: (name, callback) => {
      injectCalls.push(name)
      callback()
      return () => {}
    },
    register: (options) => { registrations.push(options); return () => {} },
  },
}

plugin.apply(ctx)
assert.equal(globalThis.__DSH_PDFCRAFT_BOOT_ERROR__, undefined, 'apply completes without the boot-error marker')

// ── assertions: the registrations the host surfaces must exist ────────
const byName = name => registrations.filter(options => options.name === name)

const tabType = tabTypes[0]
assert.ok(tabType, 'the pdfcraft tab type is registered')
assert.equal(tabType.id, 'dsh-pdfcraft-plugin')
assert.equal(tabType.kind, 'pdfcraft')
assert.deepEqual([...tabType.patterns], ['*.pdf'])
assert.equal(tabType.keepMounted, true)
assert.equal(typeof tabType.canOpen, 'function')
// canOpen is a parseability veto (extension routing belongs to patterns):
// any session-scoped file address parses true, even other extensions.
assert.equal(tabType.canOpen('dsh-resource://file/session/s1/a.pdf'), true)
assert.equal(tabType.canOpen('dsh-resource://file/session/s1/a.xlsx'), true)
assert.equal(tabType.canOpen('dsh-resource://file/absolute/a.pdf'), false)

const bodies = byName('sidebar.right.pane.tab')
assert.equal(bodies.length, 1, 'the tab body is registered')
assert.equal(bodies[0].key, 'dsh-pdfcraft-plugin')
assert.equal(byName('sidebar.right.pane.tab.title').length, 1, 'the live tab title is registered')

const cardButtons = byName('deliverables.file.actions')
assert.equal(cardButtons.length, 1, 'the file-card button is registered')
assert.equal(cardButtons[0].id, 'pdfcraft-open')

const configViews = byName('plugins.bundle.config')
assert.equal(configViews.length, 1, 'the plugins-page config section is registered')
assert.equal(configViews[0].key, 'dsh-pdfcraft-plugin', 'keyed by the bundle package name')
assert.equal(typeof configViews[0].inject, 'function')

assert.ok(injectCalls.includes('plugins.bundle.config'), 'the config slot inject guard is armed')
assert.deepEqual([...openerForms], ['pdfcraft'], 'the opener form reads the patch entry id')

console.log('✅ client apply: tab type/body/title + card button + plugins-page config all registered')
console.log('ALL CLIENT APPLY TESTS PASSED')
