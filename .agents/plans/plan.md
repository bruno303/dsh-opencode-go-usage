# Plan: Implement `dsh-opencode-go-usage` (DSH web plugin)

Source of truth for requirements: `PLAN.md` (design) and `docs/opencode-go-usage-api.md`
(verified API contract). This file normalizes them into executable tasks.

Execution config (user-specified): workers are **general subagents** on
`opencode-go/deepseek-v4.1-flash` with **reasoning effort `high`**.

## Constraints and acceptance evidence

- Data source is the verified `GET https://opencode.ai/zen/go/v1/usage` endpoint; the key is
  resolved through the DSH credential seam (`credentialRef(<apiKeyEnv>)`), never stored in config.
  Evidence: host-half unit tests + no-key-in-response assertion.
- Scope: opencode-go only; quota percentages only (no dollars).
  Evidence: no pricing/cost code in the diff.
- The secret must never reach the browser, logs, or error strings.
  Evidence: `route.test.ts` leak scan.
- Generated build output (`lib/**`) and `pnpm-lock.yaml` / `node_modules/**` are not reviewable
  source; they are verified by the build command instead. Evidence: build assertions.
- Non-goal: installing into the live `web` profile or restarting the user's running GUI
  (documented in Task 4 only, executed later by the user).

## Task 1: Package scaffold and dual-half build pipeline

**Files:** `package.json`, `tsconfig.json`, `tsdown.config.ts`, `scripts/wrap-client.mjs`,
`cordis.patch.yml`, `.gitignore`, `LICENSE`, `src/wire-types.ts`, `src/index.ts`,
`src/client/index.tsx` (all created) · generated: `lib/**`, `pnpm-lock.yaml`, `node_modules/**`
**Dependencies:** none

Two-entry build producing `lib/index.js` + `lib/index.d.ts` (Cordis host plugin) and
`lib/client.js` + `lib/client.js.map` (browser bundle wrapped for `window.__ModuleLoader__.load`).
Stub `apply` bodies establish the entry contracts; later tasks fill them in.
Verify: `pnpm install`, `pnpm run build`, `pnpm run typecheck`; assert the four artifacts exist and
the client bundle starts with the loader call.

## Task 2: Host half — parse, provider, cache, authenticated route

**Files:** `src/quota-parse.ts`, `src/quota-provider.ts`, `src/cache.ts`, `src/quota-parse.test.ts`,
`src/cache.test.ts`, `src/route.test.ts` (created) · `src/index.ts`, `src/wire-types.ts` (modified)
**Dependencies:** Task 1

Pure validator/parser for the three quota windows, an authenticated fetch with timeouts and stable
error codes, a TTL cache with in-flight dedupe, and the exact web route guarded by
`ctx.connection.admit()`.
Verify: `pnpm exec vitest run src/quota-parse.test.ts src/cache.test.ts src/route.test.ts`, `pnpm run typecheck`.

## Task 3: Client half — sidebar quota widget

**Files:** `src/client/index.tsx` (modified), `src/client/UsageIndicator.tsx`,
`src/client/usage-view.ts`, `src/client/usage-view.test.ts` (created)
**Dependencies:** Task 2

Register into the `sidebar.footer.action` list slot; compact indicator for the binding window plus a
popover with per-window rows, reset countdowns, refresh, and error/stale states. View logic lives in
pure helpers so it is testable without a DOM.
Verify: `pnpm run build`, `pnpm exec vitest run src/client`, `pnpm run typecheck`.

## Task 4: Install and test documentation

**Files:** `README.md`, `docs/install.md`, `docs/testing.md` (created) ·
`docs/opencode-go-usage-api.md`, `PLAN.md` (modified only if a link must be corrected)
**Dependencies:** Task 3

Document installation (Web Plugins page and `dsh plugin --profile web …`, bundle selection,
verification, uninstall) and testing (unit suites, build/typecheck gates, manual live checklist,
troubleshooting). Every documented command must exist in `package.json` and pass.
Verify: `pnpm run test`, `pnpm run build`, plus a check that each npm script referenced by the docs
exists in `package.json`.

## Carried-forward low findings from task gates

- **Task 1** — `package.json` `files` omitted `lib/index.js.map` while the host bundle references it:
  folded into Task 2 and fixed.
- **Task 2** — `src/route.ts` calls `admit(req)` outside the handler's top-level `try/catch`, so an
  unexpected admission throw escapes the fixed secret-free 500 path: folded into Task 3.
- **Task 2** — `src/cache.ts` serves a stale fallback after a failed *forced* refresh while the entry
  is still within its TTL, so `isFresh()` stays true and later GETs skip the provider until the
  original TTL expires: folded into Task 3 with a regression test.
- **Task 3** — no automated regression test for the admission-throw 500 path, and the route-path
  drift guard pinned literals one-directionally: folded into Task 4.
- **Task 4** — README mis-attributed the `/zen/v1/usage` non-JSON fact to the API doc (it is in
  `PLAN.md` §3), and `docs/install.md` asserted an unverified uninstall-confirmation UI behaviour:
  fixed in one bounded documentation fix pass before the aggregate review.

## Final quality gate (orchestrator, after all tasks)

- `pnpm run typecheck`
- `pnpm exec vitest run`
- `pnpm run build` with the four-artifact assertion
- record any gate that is not applicable or unavailable
