/**
 * Host-route unit tests for dsh-pdfcraft (no DSH host needed):
 *   node test/routes.mjs
 * Covers path containment, the bridge-page routes (app.html / app.js), the
 * vendor route (MIME + immutable cache + traversal refusal) and the
 * presented-file resolve route (coordinates → declared path). The plugin is
 * read-only, so unlike its siblings there is no save route to test.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createPdfcraftRoutes, createResolveRoute, resolveInsideWorkspace, PC_APP_HTML_PATH, PC_APP_JS_PATH, PC_VENDOR_BASE } from '../lib/routes.js'

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-pdfcraft-test-'))
const WORKSPACE = join(ROOT, 'ws')
const APP = join(ROOT, 'app')
const VENDOR = join(ROOT, 'static', 'vendor')
mkdirSync(WORKSPACE)
mkdirSync(APP)
mkdirSync(join(VENDOR, 'build'), { recursive: true })
mkdirSync(join(VENDOR, 'web'), { recursive: true })
writeFileSync(join(APP, 'app.html'), '<html>pc</html>')
writeFileSync(join(APP, 'app.js'), '// pc-bridge')
writeFileSync(join(VENDOR, 'build', 'pdf.min.mjs'), '// pdf-api')
writeFileSync(join(VENDOR, 'build', 'pdf.worker.min.mjs'), '// pdf-worker')
writeFileSync(join(VENDOR, 'web', 'pdf_viewer.mjs'), '// pdf-viewer')
writeFileSync(join(VENDOR, 'web', 'logo.svg'), '<svg/>')

// ── resolveInsideWorkspace ────────────────────────────────────────────
assert.equal(resolveInsideWorkspace(WORKSPACE, 'book.pdf'), join(WORKSPACE, 'book.pdf'))
assert.equal(resolveInsideWorkspace(WORKSPACE, 'sub/dir/book.pdf'), join(WORKSPACE, join('sub', 'dir', 'book.pdf')))
assert.equal(resolveInsideWorkspace(WORKSPACE, ''), undefined)
assert.equal(resolveInsideWorkspace(WORKSPACE, '..'), undefined)
assert.equal(resolveInsideWorkspace(WORKSPACE, '../escape.pdf'), undefined)
assert.equal(resolveInsideWorkspace(WORKSPACE, 'a/../../escape.pdf'), undefined)
assert.equal(resolveInsideWorkspace(WORKSPACE, '/etc/hosts'), undefined)
assert.equal(resolveInsideWorkspace(WORKSPACE, 'C:\\Windows\\evil.pdf'), undefined)
assert.equal(resolveInsideWorkspace(WORKSPACE, 'ok\0evil'), undefined)
assert.equal(resolveInsideWorkspace(WORKSPACE, '.hidden.pdf'), join(WORKSPACE, '.hidden.pdf'), 'dotfiles are legal names')
console.log('✅ resolveInsideWorkspace containment')

// ── route fixtures ────────────────────────────────────────────────────
const routes = createPdfcraftRoutes({ appDir: APP, staticDir: VENDOR })
assert.equal(routes.length, 3, 'bridge page + app.js + vendor (no save route)')
const htmlRoute = routes.find(route => route.path === PC_APP_HTML_PATH)
const jsRoute = routes.find(route => route.path === PC_APP_JS_PATH)
const vendorRoute = routes.find(route => route.path === PC_VENDOR_BASE && route.kind === 'prefix')
assert.ok(htmlRoute && jsRoute && vendorRoute, 'all three surfaces registered')

function mockRes() {
  const res = new PassThrough()
  res.statusCode = 0
  res.headers = {}
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers }
  res.body = []
  res.on('data', chunk => res.body.push(chunk))
  res.done = new Promise(resolvePromise => res.on('end', resolvePromise))
  return res
}

async function readBodyOf(res) {
  await res.done
  return Buffer.concat(res.body).toString('utf8')
}

function mockReq(method, url, body) {
  // Minimal IncomingMessage stand-in: async-iterable chunks.
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  let index = 0
  return {
    method,
    url,
    on(event, handler) {
      if (event === 'data') { setImmediate(() => { if (index < chunks.length) handler(chunks[index++]) }) }
      if (event === 'end') { setImmediate(handler) }
      if (event === 'error') { /* unused */ }
    },
    destroy() { /* unused */ },
  }
}

// ── bridge page routes (app.html / app.js) ────────────────────────────
{
  const res = mockRes()
  await htmlRoute.handler(mockReq('GET', PC_APP_HTML_PATH), res)
  await res.done
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['Content-Type'], /text\/html/)
  assert.equal(res.headers['Cache-Control'], 'no-cache', 'bridge page revalidates')
  assert.equal(await readBodyOf(res), '<html>pc</html>')

  const res2 = mockRes()
  await jsRoute.handler(mockReq('GET', PC_APP_JS_PATH), res2)
  await res2.done
  assert.equal(res2.statusCode, 200)
  assert.match(res2.headers['Content-Type'], /text\/javascript/)

  const res3 = mockRes()
  await htmlRoute.handler(mockReq('POST', PC_APP_HTML_PATH), res3)
  await res3.done
  assert.equal(res3.statusCode, 405, 'non-GET rejects')
  console.log('✅ app page: html/js served no-cache, POST rejected')
}

// ── vendor route ──────────────────────────────────────────────────────
{
  const res = mockRes()
  await vendorRoute.handler(mockReq('GET', `${PC_VENDOR_BASE}/build/pdf.min.mjs`), res)
  await res.done
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['Content-Type'], /text\/javascript/, '.mjs served as JavaScript (module worker + import need it)')
  assert.match(res.headers['Cache-Control'], /immutable/, 'vendor files cache hard')

  const res2 = mockRes()
  await vendorRoute.handler(mockReq('GET', `${PC_VENDOR_BASE}/web/logo.svg`), res2)
  await res2.done
  assert.match(res2.headers['Content-Type'], /image\/svg/, 'svg MIME')

  const res3 = mockRes()
  await vendorRoute.handler(mockReq('GET', `${PC_VENDOR_BASE}/%2e%2e%2findex.ts`), res3)
  await res3.done
  assert.equal(res3.statusCode, 400, 'encoded traversal rejected')

  const res4 = mockRes()
  await vendorRoute.handler(mockReq('GET', `${PC_VENDOR_BASE}/web/missing.css`), res4)
  await res4.done
  assert.equal(res4.statusCode, 404)

  const res5 = mockRes()
  await vendorRoute.handler(mockReq('GET', `${PC_VENDOR_BASE}/build/pdf.worker.min.mjs`), res5)
  await res5.done
  assert.equal(res5.statusCode, 200, 'module worker file reachable')
  console.log('✅ vendor: mjs/svg MIME + immutable cache + traversal/404')
}

// ── resolve route (presented coordinates → declared path) ─────────────
{
  const sessionQuery = {
    async readEvent({ sessionId, seq }) {
      if (sessionId === 's1' && seq === 7) {
        return {
          target: {
            type: 'deliverables/presented',
            data: { turn: 3, callId: 'c1', files: [{ path: 'docs/report.pdf' }, { path: 'notes.md' }] },
          },
          session: { cwd: WORKSPACE },
        }
      }
      if (sessionId === 's1' && seq === 9) throw new Error('session store offline')
      return { target: { type: 'conversation/message', data: {} } }
    },
  }
  const resolveRoute = createResolveRoute({ sessionQuery })

  const res = mockRes()
  await resolveRoute.handler(mockReq('GET', '/api/dsh-pdfcraft/resolve?sessionId=s1&seq=7&index=0'), res)
  const json = JSON.parse(await readBodyOf(res))
  assert.equal(res.statusCode, 200)
  assert.equal(json.success, true)
  assert.deepEqual(json.data, { sessionId: 's1', path: 'docs/report.pdf', name: 'report.pdf' })

  const res2 = mockRes()
  await resolveRoute.handler(mockReq('GET', '/api/dsh-pdfcraft/resolve?sessionId=s1&seq=7&index=5'), res2)
  assert.equal(res2.statusCode, 404, 'index out of range rejects')

  const res3 = mockRes()
  await resolveRoute.handler(mockReq('GET', '/api/dsh-pdfcraft/resolve?sessionId=s1&seq=7&index=1'), res3)
  assert.equal(res3.statusCode, 200, 'non-PDF declared files still resolve (client filters)')

  const res4 = mockRes()
  await resolveRoute.handler(mockReq('GET', '/api/dsh-pdfcraft/resolve?sessionId=s1&seq=8&index=0'), res4)
  assert.equal(res4.statusCode, 404, 'non-presented event rejects')

  const res5 = mockRes()
  await resolveRoute.handler(mockReq('GET', '/api/dsh-pdfcraft/resolve?sessionId=s1&seq=abc&index=0'), res5)
  assert.equal(res5.statusCode, 400, 'non-numeric coordinates reject')

  const res6 = mockRes()
  await resolveRoute.handler(mockReq('GET', '/api/dsh-pdfcraft/resolve?sessionId=s1&seq=9&index=0'), res6)
  assert.equal(res6.statusCode, 502, 'session store failures surface as 502')

  const res7 = mockRes()
  await resolveRoute.handler(mockReq('POST', '/api/dsh-pdfcraft/resolve?sessionId=s1&seq=7&index=0'), res7)
  assert.equal(res7.statusCode, 405, 'non-GET rejects')
  console.log('✅ resolve: happy path + 404/400/405/502 rejections')
}

rmSync(ROOT, { recursive: true, force: true })
console.log('ALL ROUTE TESTS PASSED')
