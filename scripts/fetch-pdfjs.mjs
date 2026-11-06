/**
 * Fetch the official PDF.js viewer components into static/vendor/.
 *
 * The plugin embeds the prebuilt `pdfjs-dist` package (build/pdf.min.mjs +
 * build/pdf.worker.min.mjs, web/pdf_viewer.mjs + pdf_viewer.css + images/),
 * so the vendor assets stay out of git: run `npm run fetch-pdfjs` once after
 * cloning. The npm tarball is downloaded from the registry and unpacked with
 * the system tar (bsdtar ships with Windows 10+/most Unix).
 *
 * The package's INTERNAL layout is preserved (vendor/build/…, vendor/web/…):
 * web/pdf_viewer.css references url(images/…) relative to itself, and the
 * viewer components read the pdf.js API from `globalThis.pdfjsLib`, which
 * build/pdf.mjs installs as a module side effect — the app page imports the
 * build first, the components second.
 *
 * Idempotent — skips the download when static/vendor/build/pdf.min.mjs
 * already exists unless --force is passed.
 */
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(__dirname, '..')
const VENDOR_DIR = resolve(PLUGIN_ROOT, 'static', 'vendor')
const MARKER = resolve(VENDOR_DIR, 'build', 'pdf.min.mjs')

const VERSION = '6.4.299'
const TARBALL_URL = `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-${VERSION}.tgz`
/** package-internal member → destination file (relative to vendor/). */
const WANTED_FILES = [
  'build/pdf.min.mjs',
  'build/pdf.worker.min.mjs',
  'web/pdf_viewer.mjs',
  'web/pdf_viewer.css',
]
/** The viewer css references url(images/…) — the whole directory rides along. */
const IMAGES_MEMBER = 'web/images'

const force = process.argv.includes('--force')

if (!force && existsSync(MARKER)) {
  console.log(`[fetch-pdfjs] static/vendor/ already populated (${statSync(MARKER).size} bytes pdf.min.mjs) — skipping. Use --force to re-download.`)
  process.exit(0)
}

console.log(`[fetch-pdfjs] downloading ${TARBALL_URL} …`)
const res = await fetch(TARBALL_URL, { redirect: 'follow' })
if (!res.ok || !res.body) {
  console.error(`[fetch-pdfjs] download failed: HTTP ${res.status} ${res.statusText}`)
  process.exit(1)
}

// Downloaded archives are untrusted: unpack in a fresh temp directory, then
// copy out only the wanted members.
const scratch = mkdtempSync(join(tmpdir(), `dsh-pdfcraft-fetch-${randomBytes(4).toString('hex')}-`))
const tgzPath = join(scratch, `pdfjs-dist-${VERSION}.tgz`)
try {
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tgzPath))
  console.log(`[fetch-pdfjs] downloaded ${statSync(tgzPath).size} bytes`)

  console.log('[fetch-pdfjs] extracting …')
  // Relative filenames with cwd: GNU tar (Git Bash) reads a `C:\...` argument
  // as a remote host spec, so absolute Windows paths must stay off the argv.
  await execFileAsync('tar', ['-xzf', `pdfjs-dist-${VERSION}.tgz`], { cwd: scratch })

  const packageDir = join(scratch, 'package')
  for (const member of WANTED_FILES) {
    const source = join(packageDir, ...member.split('/'))
    if (!existsSync(source)) {
      console.error(`[fetch-pdfjs] tarball is missing ${member} — unexpected package layout`)
      process.exit(1)
    }
    const target = resolve(VENDOR_DIR, ...member.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    rmSync(target, { force: true })
    writeFileSync(target, readFileSync(source))
    console.log(`[fetch-pdfjs] ${member} → static/vendor/${member} (${statSync(target).size} bytes)`)
  }

  const imagesSource = join(packageDir, ...IMAGES_MEMBER.split('/'))
  if (!existsSync(imagesSource)) {
    console.error(`[fetch-pdfjs] tarball is missing ${IMAGES_MEMBER}/ — unexpected package layout`)
    process.exit(1)
  }
  const imagesTarget = resolve(VENDOR_DIR, ...IMAGES_MEMBER.split('/'))
  rmSync(imagesTarget, { recursive: true, force: true })
  mkdirSync(imagesTarget, { recursive: true })
  let imageCount = 0
  for (const entry of readdirSync(imagesSource, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    writeFileSync(join(imagesTarget, entry.name), readFileSync(join(imagesSource, entry.name)))
    imageCount++
  }
  console.log(`[fetch-pdfjs] ${IMAGES_MEMBER}/ → static/vendor/${IMAGES_MEMBER}/ (${imageCount} files)`)

  writeFileSync(resolve(VENDOR_DIR, 'version.txt'), `pdfjs-dist ${VERSION}\n`)
  console.log('[fetch-pdfjs] done — static/vendor/ ready')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
