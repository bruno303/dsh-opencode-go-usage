#!/usr/bin/env node
/**
 * Wrap the raw CJS client intermediate into the browser bundle DSH loads.
 *
 * `tsdown` emits a plain CommonJS module (`lib/client.cjs`, + map). DSH's
 * browser module facade does not load plain CJS: it loads a bundle that
 * registers itself on the page-global `window.__ModuleLoader__` and hands the
 * plugin a `require`. This script performs that last, non-expressible-in-tsdown
 * step:
 *
 *   1. reads the plugin id from `package.json` (single source of truth — never a
 *      second hardcoded copy),
 *   2. asserts the compiled body really exports `apply` and is not already
 *      wrapped, after stripping the intermediate's own `sourceMappingURL`
 *      comment and a duplicate `Symbol.toStringTag` declaration,
 *   3. writes `lib/client.js` in the exact facade format,
 *   4. writes `lib/client.js.map`, offsetting the intermediate's mappings so the
 *      map stays accurate for the wrapped file (`file` retargeted to
 *      `client.js`),
 *   5. deletes the CJS intermediate (and its map).
 *
 * Any failed assertion exits non-zero: a broken client bundle makes DSH fail
 * plugin activation loudly at runtime, which is strictly worse than failing the
 * build.
 */

import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const libDir = join(root, 'lib')

const INTERMEDIATE = join(libDir, 'client.cjs')
const INTERMEDIATE_MAP = `${INTERMEDIATE}.map`
const OUTPUT = join(libDir, 'client.js')
const OUTPUT_MAP = join(libDir, 'client.js.map')

/** Fail loudly with a prefixed message. */
function fail(message) {
  console.error(`[wrap-client] ERROR: ${message}`)
  process.exit(1)
}

function readJson(path, what) {
  if (!existsSync(path)) fail(`${what} not found at ${path} (did \`tsdown\` run?)`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return fail(`${what} at ${path} is not valid JSON: ${error.message}`)
  }
}

// --- 1. identity -----------------------------------------------------------

const pkg = readJson(join(root, 'package.json'), 'package.json')
if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
  fail('package.json has no "name"')
}
const pluginId = pkg.name

// --- 2. read and validate the compiled body --------------------------------

if (!existsSync(INTERMEDIATE)) {
  fail(`compiled client intermediate not found at ${INTERMEDIATE}`)
}
const rawBody = readFileSync(INTERMEDIATE, 'utf8')

if (rawBody.trim().length === 0) {
  fail(`compiled client intermediate ${INTERMEDIATE} is empty`)
}

// The client half must be ONE self-contained module: DSH's facade has no way to
// load a second chunk. The build sets `outputOptions.codeSplitting: false`; this
// asserts the result, so a future dynamic import cannot silently emit a chunk
// the wrapper would drop on the floor.
const strayChunks = readdirSync(libDir).filter((entry) => entry.endsWith('.cjs') && entry !== 'client.cjs')
if (strayChunks.length > 0) {
  fail(
    `the client build emitted extra CJS chunk(s) ${strayChunks.join(', ')} — ` +
      `the browser half must bundle to a single file`,
  )
}

/**
 * Normalise the intermediate before wrapping.
 *
 * - Drop the intermediate's own `sourceMappingURL` comment. It points at
 *   `client.cjs.map`, which this script deletes; leaving it would make the
 *   shipped bundle advertise a map that does not exist. Only a *trailing*
 *   comment is removed, so no mapped line can shift.
 * - Drop a leading `Object.defineProperty(exports, Symbol.toStringTag, …)`
 *   line, because the wrapper header already declares the same thing for the
 *   same `exports` object. Redefining an identical, non-configurable property
 *   is legal but noisy. This removal *does* shift every later line up by one,
 *   so it is counted in `bodyLinesRemoved` and subtracted from the map offset.
 */
let body = rawBody.replace(/(?:\r?\n)?[ \t]*\/\/[#@][ \t]*sourceMappingURL=[^\n]*[ \t]*$/, '')

let bodyLinesRemoved = 0
const TOSTRINGTAG_RE =
  /^[ \t]*Object\.defineProperty\(exports,\s*Symbol\.toStringTag,\s*\{\s*value:\s*["']Module["']\s*\}\);?[ \t]*\r?\n/
const duplicateTag = body.match(TOSTRINGTAG_RE)
if (duplicateTag) {
  bodyLinesRemoved = (duplicateTag[0].match(/\n/g) ?? []).length
  body = body.slice(duplicateTag[0].length)
}

if (body.includes('__ModuleLoader__')) {
  fail(
    `compiled client body already references __ModuleLoader__ — it looks pre-wrapped; ` +
      `the intermediate must be a raw CJS module`,
  )
}

/**
 * The body must export `apply`. Because the exact CJS lowering is the bundler's
 * business, accept any of the shapes a CJS/ESM-to-CJS lowering produces for a
 * named `apply` export.
 */
const APPLY_EXPORT_PATTERNS = [
  // exports.apply = apply / exports["apply"] = apply
  /(?:^|[^\w$.])exports\s*(?:\.\s*apply\b|\[\s*["']apply["']\s*\])/,
  // module.exports = { ..., apply, ... } (no nested braces before `apply`)
  /module\s*\.\s*exports\s*=\s*\{[^{}]*\bapply\b[^{}]*\}/,
  // Object.defineProperty(exports, "apply", ...)
  /Object\s*\.\s*defineProperty\s*\(\s*exports\s*,\s*["']apply["']/,
  // ESM named export surviving a non-CJS lowering: export { apply } / export function apply
  /\bexport\s*\{[^}]*\bapply\b[^}]*\}/,
  /\bexport\s+(?:async\s+)?function\s+apply\b/,
]

if (!APPLY_EXPORT_PATTERNS.some((pattern) => pattern.test(body))) {
  fail(
    'compiled client body does not appear to export `apply` — ' +
      'the browser half must export a Cordis `apply` entry point',
  )
}

// --- 3. assemble the facade-wrapped bundle ---------------------------------

// NOTE: the body is inserted verbatim, at column 0 and on its own line, so the
// source map offset below is exact for the whole (unindented) body.
const header =
  `window.__ModuleLoader__.load({\n` +
  `\tid: ${JSON.stringify(pluginId)},\n` +
  `\tfactory: (require) => {\n` +
  `\t\tvar module = { exports: {} };\n` +
  `\t\tvar exports = module.exports;\n` +
  `\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n`

const footer = `\t\treturn module.exports;\n` + `\t}\n` + `});\n`

// Number of generated lines the body is shifted down by: one per newline in the
// header, minus the body lines that normalisation removed *before* the first
// mapped line (the body starts on the line after the last header newline).
const headerLines = (header.match(/\n/g) ?? []).length
const lineOffset = headerLines - bodyLinesRemoved

if (headerLines <= 0) fail('internal error: computed a non-positive header line count')
if (lineOffset < 0) {
  fail(`internal error: body normalisation removed ${bodyLinesRemoved} lines, more than the header (${headerLines})`)
}

const bundle = `${header}${body.replace(/\n?$/, '\n')}${footer}\n//# sourceMappingURL=client.js.map\n`

// Parse-only validation: catches a broken concatenation without executing the
// bundle (which would need `window`, `react`, and the module facade).
try {
  new vm.Script(bundle, { filename: 'client.js' })
} catch (error) {
  fail(`the wrapped bundle is not valid JavaScript: ${error.message}`)
}

// --- 4. source map ---------------------------------------------------------

if (!existsSync(INTERMEDIATE_MAP)) {
  fail(`compiled client sourcemap not found at ${INTERMEDIATE_MAP}`)
}
const map = readJson(INTERMEDIATE_MAP, 'client sourcemap')

if (typeof map.mappings !== 'string') {
  fail('client sourcemap has no "mappings" string')
}

// One `;` per generated line: prepending `lineOffset` of them shifts every
// mapping down to where the body now starts. Columns are untouched because the
// body is inserted verbatim at column 0.
const wrappedMap = {
  ...map,
  file: 'client.js',
  mappings: ';'.repeat(lineOffset) + map.mappings,
}

// --- 5. write, then remove the intermediate --------------------------------

writeFileSync(OUTPUT, bundle)
writeFileSync(OUTPUT_MAP, JSON.stringify(wrappedMap))

rmSync(INTERMEDIATE, { force: true })
rmSync(INTERMEDIATE_MAP, { force: true })

console.log(
  `[wrap-client] wrote lib/client.js (id: ${pluginId}, body offset ${lineOffset} lines) and lib/client.js.map`,
)
