# Task 3 brief — client half: sidebar quota widget (+ two carried-over host fixes)

## Context

Project root: `/home/bruno/dev/projects/dsh-opencode-go-usage` (**not a git repo** — no git commands).
Tasks 1–2 are complete and passed review: the package builds two halves, and the host half serves
`GET /__dsh_opencode_go_usage__/usage` and `POST /__dsh_opencode_go_usage__/refresh` behind
`ctx.connection.admit()`, returning the `UsageEnvelope` union declared in `src/wire-types.ts`.

Read before coding:
- `PLAN.md` §4 (client half) and §6.4 (manual checklist).
- `docs/opencode-go-usage-api.md` — the upstream contract (three quota windows).
- Installed slot/renderer contracts:
  `/home/bruno/.nvm/versions/node/v24.14.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/README.md`
  and `.../dsh-client-ui-slots/lib/types/index.d.ts` (the `register` overloads and `BaseOptions`).
- The slot declaration you target: `.../dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts`
  → `'sidebar.footer.action'` is `kind: 'list'` with owner share `SidebarFooterActionOwnerProps { wide: boolean }`.
- A working out-of-tree example of client registration and the bundle shape:
  `/home/bruno/.dsh/profiles/web/node_modules/dsh-lan-guard/lib/client.js` (see how it calls
  `ctx.slots.register({ name, id, order, label }, Component)` and what it exports).

## Goal of this task

Make the widget real: a compact indicator in the sidebar foot plus a detail popover, driven by the
host route, with view logic pure enough to unit-test without a DOM. Plus two small carried-over host
fixes (§7).

## Deliverables

### 1. `src/client/usage-view.ts` (pure — no React, no DOM, no dsh imports)
View-model helpers used by the component and tested directly:
- `formatPercent(percentUsed: number): string` — `0.19` → `"19%"`, `0` → `"0%"`, `1` → `"100%"`.
  Clamp to `[0, 100]`; round to the nearest integer.
- `formatCountdown(resetsAt: string, nowMs: number): string` — compact, human, e.g. `"in 3d 4h"`,
  `"in 5h 12m"`, `"in 47m"`, `"in 30s"`, and `"now"` when the instant is at or before `nowMs`.
  Unparseable input → `"unknown"`.
- `windowSeverity(percentUsed: number, limitReached: boolean): 'ok' | 'warning' | 'critical'` —
  `critical` when `limitReached`; `warning` at `>= 0.8`; otherwise `ok`.
- `describeEnvelope(envelope: UsageEnvelope | undefined, nowMs: number): UsageView` where
  `UsageView` is a discriminated view model:
  - `{ kind: 'loading' }` for `undefined`
  - `{ kind: 'ok'; label; binding: string | null; percentText: string; severity; stale: boolean; fetchedAtText: string; windows: Array<{ id; label; percentText; severity; resetsIn: string; limitReached }> }`
  - `{ kind: 'error'; reason: UsageFailureReason; message: string; status?: number }` with
    human-readable, secret-free copy per reason, e.g. `key-missing` → "No API key is configured for
    this provider."; `key-invalid` → "The configured API key was rejected."; `not-found` → "The usage
    endpoint was not found."; `network` → "Could not reach the usage endpoint."; `parse` → "The usage
    response could not be read."; `http` → "The usage endpoint returned an error."
    Always surface the server-provided `status` when present.
- `fetchUsage(fetchImpl: typeof fetch, url: string): Promise<UsageEnvelope>` — `GET` the URL with
  `Accept: application/json` and same-origin credentials; map a non-JSON or transport failure to a
  safe `{ ok: false, reason: 'network' }`-style envelope rather than throwing. Never throw.
- `refreshUsage(fetchImpl: typeof fetch, url: string): Promise<UsageEnvelope>` — same, but `POST`.

### 2. `src/client/UsageIndicator.tsx` (React component)
- Accepts the slot owner share `{ wide?: boolean }` plus optional injected props for testability
  (e.g. `fetchImpl`). Keep the component thin: all formatting/severity/copy decisions come from
  `usage-view.ts`.
- Collapsed rail (`wide === false`): icon-only button with an accessible name (`aria-label`/`title`)
  and a small severity dot. Expanded: the same button showing the binding-window percent text.
- Clicking toggles a popover showing: the provider label, the binding-window percent, `fetchedAt`
  as relative text, one row per window (label, percent bar, severity color, reset countdown), a
  `stale` marker when the snapshot is stale, a Refresh button (POST) that is disabled while
  in-flight, and error copy from the view model.
- Loads once on mount; refresh re-fetches; state transitions must be safe against unmount
  (no state updates after unmount) and against out-of-order responses.
- Styling: inline styles only, using CSS custom properties where the shell provides them; **no CSS
  files** and no UI-library imports.

### 3. `src/client/index.tsx` (modified)
- `export const inject = ['slots']` (keep the verified client entry shape: `inject` + `apply`).
- In `apply(ctx)`, register `UsageIndicator` into the existing declared list slot
  `'sidebar.footer.action'` using the `ctx.slots.register({ name, id, order, label }, Component)`
  form (verify the exact option fields against the installed types). Use the package name as the
  registration `id` and a stable ascending `order`.
- Guarantee disposal when the plugin unloads: use the mechanism the installed slots API supports
  (e.g. `ctx.effect(...)` or the returned disposer) and record which you used and why.
- Do **not** import any `@deepseek-ai/*` package from client code; only `react` / `react/jsx-runtime`
  may be required (they are platform-baseline). No `dsh.client.external` entry may be needed — if you
  believe one is, stop and report it as a blocker instead of adding it silently.

### 4. `src/client/usage-view.test.ts` (pure tests, no DOM)
Cover: percent formatting including clamping and rounding; countdown across days/hours/minutes/
seconds and past instants; unparseable date; severity thresholds (`0.79`, `0.8`, `limitReached`);
`describeEnvelope` for `undefined`, an ok snapshot (windows, stale flag, error-free copy) and every
failure reason; `fetchUsage`/`refreshUsage` with injected fakes for success, non-JSON body,
non-2xx status, and a rejecting fetch (must resolve, never throw). Include a case asserting the
rendered error copy never contains a credential-looking token.

### 5. Route-path consistency
The client must call exactly the host routes `'/__dsh_opencode_go_usage__/usage'` (GET) and
`'/__dsh_opencode_go_usage__/refresh'` (POST). Importing the constants from `src/route.ts` into the
client bundle would pull node-side code into the browser bundle — so **declare the two paths as
client-local constants** and add a test asserting they equal the literals above (a drift guard).

### 6. Build integrity
`pnpm run build` must still emit `lib/client.js` in the wrapped
`window.__ModuleLoader__.load({ id: "dsh-opencode-go-usage", factory: (require) => { ... } })` form,
and `lib/client.js` must contain `sidebar.footer.action`.

### 7. Carried-over host fixes (from the Task 2 review — small and mandatory)
- `src/route.ts`: move the `admit(req)` call and its refusal branch **inside** the handler's
  top-level `try/catch`, so an unexpected admission throw still produces the fixed, secret-free 500
  response instead of escaping the handler.
- `src/cache.ts`: after serving a stale fallback because a load failed with `network`/`parse`, the
  entry must no longer report `isFresh() === true` (e.g. reset the stored timestamp to
  `now() - ttlMs`, or track a stale flag that `isFresh()` honors). Otherwise a failed *forced*
  refresh inside the previous snapshot's TTL leaves later GETs serving the stale copy until the
  original TTL expires.
- Extend `src/cache.test.ts` with a regression test for exactly that path: previous good snapshot
  still within TTL → forced refresh fails with `network` → `isFresh()` is false (or the next GET
  attempts the provider again) while the stale snapshot is still what gets served.

## Conventions

- TypeScript strict, ESM, `import type` for types; no unjustified `any`.
- Keep `usage-view.ts` free of React so it stays trivially testable.
- Never weaken a test to make it pass. Never put a credential, header, or raw upstream body into
  client copy.
- Comments explain *why* for non-obvious behavior (stale handling, out-of-order fetch guard); do not
  narrate the obvious.

## Verification (run these; record exact commands and observed results)

```bash
pnpm exec vitest run src/client
pnpm run test
pnpm run typecheck
pnpm run build
test -f lib/client.js && head -c 40 lib/client.js        # must start with window.__ModuleLoader__.load(
grep -c 'sidebar.footer.action' lib/client.js            # must be >= 1
```

## Writable scope (only these paths)

Created: `src/client/usage-view.ts`, `src/client/UsageIndicator.tsx`, `src/client/usage-view.test.ts`.
Modified: `src/client/index.tsx`, `src/route.ts`, `src/cache.ts`, `src/cache.test.ts`.

Allowed generated side effects (excluded from review): `lib/**`, `pnpm-lock.yaml`, `node_modules/**`.
Report path (also allowed): `.agents/plans/task-3-report.md`.

If you need any other path, stop and reply exactly
`BLOCKED: SCOPE_EXPANSION: <path> — <reason>` instead of editing it.

## Report (final step — mandatory)

Write `.agents/plans/task-3-report.md`: status, changed paths, key decisions (slot registration and
disposal mechanism, fetch/state handling, the two carried-over fixes), exact verification commands
with observed results, and any blocker or not-applicable check.
