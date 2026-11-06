import { build } from 'esbuild'
import { resolve, dirname } from 'path'
import { writeFileSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(resolve(__dirname, 'src/client/pdfcraft.css'), 'utf8')
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'))

const result = await build({
  entryPoints: [resolve(__dirname, 'src/client/index.tsx')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: '__dshPdfcraft',
  platform: 'browser',
  target: 'es2020',
  minify: false,
  sourcemap: false,
  jsx: 'automatic',
  loader: {
    '.ts': 'ts',
    '.tsx': 'tsx',
  },
  // React must stay external: PLATFORM_MODULES seeds the shared react /
  // react/jsx-runtime / react-dom instances, and slot components render inside
  // the HOST React tree. Bundling a private copy crashes rendering (element
  // identity mismatch) and would break hooks. The factory's `require` resolves
  // these specifiers from the shell's module table — including
  // dsh-client-ui-primitives (the shared Switch), also in PLATFORM_MODULES.
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
    // Inline the stylesheet so the client needs no runtime CSS fetch and the
    // host module loader stays a single JS file.
    '__PC_CSS__': JSON.stringify(css),
    // Console marker so a stale cached bundle is recognizable in the browser.
    '__PC_VERSION__': JSON.stringify(pkg.version),
  },
})

const code = result.outputFiles[0].text

// Wrap in __ModuleLoader__ format.
// The host only passes `require` to the factory — we must create module/exports locally.
// The registration id MUST equal package.json `name` (and the cordis patch entry
// `name`): a mismatched id makes the bundle execute twice (second load throws
// "duplicate factory registration"), failing web boot — see dsh-kanban.
//
// `inject` must survive the copy: the Loader activates the module exports as a
// cordis plugin, and without the declared inject the context guard rejects
// every service access ("cannot get property … without inject").
const wrapped = `window.__ModuleLoader__.load({
  id: "dsh-pdfcraft-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${code}
    exports.apply = __dshPdfcraft.apply;
    if (__dshPdfcraft.inject !== undefined) exports.inject = __dshPdfcraft.inject;
    return module.exports;
  }
});
`

writeFileSync(resolve(__dirname, 'lib/client.js'), wrapped)
console.log('✅ Build complete: lib/client.js')
