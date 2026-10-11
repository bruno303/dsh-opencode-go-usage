import { defineConfig } from 'tsdown'

/**
 * Two-entry build for a DSH out-of-tree plugin.
 *
 * 1. Host half — `src/index.ts` → `lib/index.js` (+ `lib/index.d.ts`, sourcemap).
 *    Node ESM; every `@deepseek-ai/*` package and node builtin stays external so
 *    the bundle links against the DSH runtime the host already loaded.
 *
 * 2. Client half — `src/client/index.tsx` → a raw CJS intermediate `lib/client.cjs`
 *    (+ map). `scripts/wrap-client.mjs` turns that intermediate into the final
 *    `lib/client.js` browser bundle and deletes the intermediate. CJS is required
 *    because DSH's browser module facade hands the plugin factory a `require`.
 *
 * Both halves deliberately keep `@deepseek-ai/*` out of the bundle. The client
 * half additionally externalises only `react` / `react/jsx-runtime`, which are
 * the two platform-baseline modules the browser facade can resolve — there is no
 * `dsh.client.external` escape hatch, so anything else must be bundled.
 *
 * The two configs intentionally share `outDir: 'lib'`: only the first run cleans
 * it, so the second half does not wipe the first half's artifacts.
 */
const DSH_PACKAGES = /^@deepseek-ai\//

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    // The package is `"type": "module"`, so tsdown would otherwise emit
    // `.mjs` / `.d.mts`. DSH resolves the host half through the package
    // `exports` map, which names `lib/index.js` and `lib/index.d.ts`.
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    dts: true,
    sourcemap: true,
    clean: true,
    deps: { neverBundle: [DSH_PACKAGES] },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // Browser baseline: no Node builtins and no Node-only syntax lowering.
    target: 'es2022',
    // The intermediate is consumed by `scripts/wrap-client.mjs`, not shipped.
    outExtensions: () => ({ js: '.cjs' }),
    dts: false,
    sourcemap: true,
    clean: false,
    // No code splitting and no dynamic chunks: the wrapper must receive one
    // self-contained CJS body. (`codeSplitting` is a rolldown output option;
    // tsdown passes `outputOptions` straight through.)
    outputOptions: { codeSplitting: false },
    deps: { neverBundle: ['react', 'react/jsx-runtime'] },
  },
])
