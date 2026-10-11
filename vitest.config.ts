import { configDefaults, defineConfig } from 'vitest/config'

/**
 * Test discovery is confined to this package's own sources.
 *
 * The orchestrator that built this plugin keeps workflow artifacts (revision
 * snapshots, review diffs) under `.agents/plans/`. Those snapshots contain
 * copies of test files from earlier revisions, so the default `**\/*.test.ts`
 * glob would pick them up and report phantom failures (`Cannot find module
 * './cache.js'`) from directories that are not part of the build. Excluding
 * `.agents/**` keeps `pnpm exec vitest run` reporting exactly the four real
 * suites under `src/`.
 *
 * `configDefaults.exclude` is spread first so the built-in ignores
 * (`node_modules`, `dist`, editor/temp directories, …) stay in effect.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.agents/**'],
  },
})
