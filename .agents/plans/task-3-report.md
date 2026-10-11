# Task 3 report — client half: sidebar quota widget (+ two carried-over host fixes)

Status: **complete**. All brief verification commands were run by me in
`/home/bruno/dev/projects/dsh-opencode-go-usage` and passed; observed results are
recorded verbatim below.

## Changed paths

Created (exact writable scope):

| Path | Lines | Contents |
|---|---|---|
| `src/client/usage-view.ts` | 340 | Pure view model: `formatPercent`, `formatCountdown`, `windowSeverity`, `describeEnvelope`, `fetchUsage`, `refreshUsage`, the two client-local route constants, and the `UsageView` union |
| `src/client/UsageIndicator.tsx` | 283 | `sidebar.footer.action` occupant: collapsed/expanded button, severity dot, detail popover, refresh |
| `src/client/usage-view.test.ts` | 428 | 33 pure tests (no DOM, no real network) |

Modified:

| Path | Changed lines | Change |
|---|---|---|
| `src/client/index.tsx` | 61 | Slot registration + disposal; dropped the `@deepseek-ai/cordis` type import in favour of a local structural context |
| `src/route.ts` | 25 | `admit(req)` and its refusal branch moved inside the handler's `try` |
| `src/cache.ts` | 11 | Stale fallback now expires the stored TTL window |
| `src/cache.test.ts` | 24 | Regression test for that stale-TTL path |

No file outside the writable scope was touched. Compared against
`.agents/plans/snapshots/task-3-before/` (the orchestrator's pre-task snapshot of
exactly those four files), the diffs contain no other paths. Generated side
effects only: `lib/**` (rebuilt), and `pnpm-lock.yaml` / `node_modules/**`
untouched because no dependency was added.

## Key decisions

### 1. Slot registration and disposal (`src/client/index.tsx`)

```ts
ctx.slots.inject(SLOT, () =>
  ctx.slots.register(
    { name: SLOT, id: PLUGIN_ID, order: ORDER, label: 'OpenCode Go usage' },
    UsageIndicator,
  ),
)
```

- **Option fields verified against the installed contract** (`0.2.0-rc.2`):
  `BaseOptions` in
  `/home/bruno/.nvm/.../@deepseek-ai/dsh-client-ui-slots/lib/types/index.d.ts`
  (lines 555–613) supplies `name` plus the list-kind `id` / `order` / `label`;
  `'sidebar.footer.action'` is `kind: 'list'` with owner share
  `SidebarFooterActionOwnerProps { wide: boolean }`
  (`dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts`). `id` is the
  package name, `order` is the stable ascending `100` (same convention as
  lan-guard, leaving room on both sides).
- **Disposal mechanism used: `ctx.slots.inject` + the fiber-bound `register`.**
  `SlotRegistry.register` is documented as a *prototype* method — "disposal
  through the caller's `ctx.effect` (fiber unload = cascade)" — and the cordis
  service proxy binds `this.ctx` to the caller's fiber precisely so plugin unload
  is the disposal axis. `inject` (`registry.d.ts` lines 97–111) adds an
  idempotent, caller-fiber-owned wait disposer and, unlike a bare `register`,
  tolerates being loaded before `ui-sidebar` commits the declaration (a
  registration into a not-yet-declared slot throws at activation). No explicit
  `ctx.effect(...)` wrapper was added: it would register the same lifetime twice
  for no gain. `ctx.effect` was *not* needed and is therefore not part of the
  local context type.
- **No `@deepseek-ai/*` import in client code.** `src/client/index.tsx` no longer
  imports `@deepseek-ai/cordis`; the `slots` service and the client context are
  typed structurally (`SlotsServiceLike`, `ClientContext`) from the verified
  contracts. Rationale: the client half may only `require` `react` /
  `react/jsx-runtime`, and the slots/UI packages are not resolvable from this
  package's `node_modules` (adding them would require editing `package.json`,
  which is out of scope). This trades compile-time contract checking for a
  runtime-shape-preserving bundle; the option literals above are the pinned
  evidence. No `dsh.client.external` entry was needed. Verified in the bundle:
  `grep -o 'require("[^"]*")' lib/client.js` → only `react` and
  `react/jsx-runtime`; `grep -c '@deepseek-ai' lib/client.js` → `0`.

### 2. Fetch and state handling (`usage-view.ts` + `UsageIndicator.tsx`)

- `fetchUsage` / `refreshUsage` **never reject**: a rejecting `fetch`, an
  unreadable (non-JSON) body, and a non-2xx status all become failure envelopes.
  A non-JSON body maps to `network` (an intermediary's page, not a quota
  reading) exactly as the brief specifies; a JSON body that fails the structural
  guard maps to `parse`. Requests are `credentials: 'same-origin'` with
  `Accept: application/json`; the browser never talks to the provider.
- **Fixed copy only.** `describeEnvelope` renders a per-reason constant string
  from the brief and surfaces the server `status`, but deliberately discards the
  server's free-text `message`, so even a future host regression cannot paint
  server text (let alone a credential) into the sidebar. A test feeds envelopes
  whose `message` contains `Bearer sk-live-…` and asserts the rendered view never
  matches `/sk-[A-Za-z0-9]{8,}/`, never contains the secret, and never contains
  `Bearer`.
- **Unmount / out-of-order safety.** Two refs: `mounted` (no state write after
  unmount; re-set to `true` at effect start so React 18 StrictMode's double
  invocation cannot leave it stuck `false`) and a monotonic `ticket` (a
  superseded response is dropped, and only the newest request clears its own
  in-flight spinner). The `refresh` button is disabled while a request is in
  flight, so two rapid clicks produce one provider call.
- **Styling**: inline styles only, no CSS file, no UI library. Colours and
  radii read the shell's real custom properties with fallbacks
  (`--dsw-alias-state-success/warn/error-primary`, `--dsw-alias-label-secondary`,
  `--dsw-alias-bg-overlay`, `--dsw-alias-border-l3`, `--dsw-radius-sm|md`,
  `--dsw-alias-interactive-bg-hover`, `--dsw-alias-fill-tertiary`), confirmed
  present in the installed sidebar/renderer bundles.
- **Route-path drift guard**: `USAGE_PATH` / `REFRESH_PATH` are declared in
  `usage-view.ts` (never imported from `src/route.ts`, which would pull node-side
  code into the browser bundle) and a test pins both literals.

### 3. Carried-over host fix — `src/route.ts`

`deps.admit(req)` and the refusal branch now sit **inside** the handler's
top-level `try`, so an unexpected admission throw becomes the fixed 500
(`{"ok":false,"reason":"http","status":500,"message":"internal error"}`) instead
of escaping the handler with its message.

Verified against the real source with a throwaway harness (in the OS temp area,
outside the repo, deleted afterwards) that drives `createUsageHandler` from
`src/route.ts` with an `admit` that throws `Bearer sk-leak-should-not-escape`:

```
admit-throw GET  -> 500 {"ok":false,"reason":"http","status":500,"message":"internal error"}
leaks internal text: false
admit-throw POST -> 500 {"ok":false,"reason":"http","status":500,"message":"internal error"}
refusal passthrough -> 403 {"ok":false,"reason":"http","status":403}
```

The same probe against the pre-fix snapshot
(`.agents/plans/snapshots/task-3-before/src/route.ts`) confirmed the old
behaviour:

```
before-fix: THREW out of the handler -> Bearer sk-leak-should-not-escape
before-fix: response status 0 (0 = nothing written)
```

### 4. Carried-over host fix — `src/cache.ts`

After serving a `network`/`parse` stale fallback the entry now sets
`storedAt = now() - ttlMs`, so `isFresh()` is false immediately and the next GET
retries the provider, while the stale snapshot is still what `get()` returns and
what is served. Before the fix, a *forced* refresh failing inside the previous
snapshot's TTL left `storedAt` untouched and later GETs kept serving the stale
copy for the remainder of the original TTL.

`src/cache.test.ts` gained the mandated regression test: previous good snapshot
fresh inside a 1000 ms TTL → forced load fails `network` → stale snapshot served
with the original `fetchedAt` and `stale: true` → `isFresh()` false → a following
unforced `load` calls the loader exactly once and stores a `stale: false`
reading.

## Verification (exact commands and observed results)

All commands run from `/home/bruno/dev/projects/dsh-opencode-go-usage`.

1. `pnpm exec vitest run src/client` — **exit 0**

```
 ✓ src/client/usage-view.test.ts (33 tests) 30ms

 Test Files  1 passed (1)
      Tests  33 passed (33)
```

2. `pnpm run test` — **exit 0**

```
 ✓ src/cache.test.ts (22 tests) 9ms
 ✓ src/quota-parse.test.ts (21 tests) 11ms
 ✓ .agents/plans/snapshots/task-3-before/src/cache.test.ts (21 tests) 10ms
 ✓ src/client/usage-view.test.ts (33 tests) 32ms
 ✓ src/route.test.ts (21 tests) 31ms

 Test Files  5 passed (5)
      Tests  118 passed (118)
```

   (`src/cache.test.ts` went from 21 to 22 tests. The
   `.agents/plans/snapshots/task-3-before/…` file is a pre-existing
   orchestrator snapshot that vitest's default include glob already picked up
   before this task; it tests the snapshot's own `cache.ts` copy and is not mine.)

3. `pnpm run typecheck` — **exit 0**, output:

```
$ tsc --noEmit
```

4. `pnpm run build` — **exit 0** (tail):

```
ℹ  [CJS] 2 files, total: 54.83 kB
✔  Build complete in 66ms
ℹ  [ESM] lib/index.js      15.72 kB │ gzip:  5.59 kB
ℹ  [ESM] lib/index.js.map  35.71 kB │ gzip: 11.69 kB
ℹ  [ESM] lib/index.d.ts     2.74 kB │ gzip:  1.15 kB
ℹ  [ESM] 3 files, total: 54.16 kB
✔  Build complete in 174ms
[wrap-client] wrote lib/client.js (id: dsh-opencode-go-usage, body offset 5 lines) and lib/client.js.map
```

5. `test -f lib/client.js && head -c 40 lib/client.js` — **exit 0**

```
window.__ModuleLoader__.load({
	id: "dsh
```

   i.e. the wrapped `window.__ModuleLoader__.load({ id: "dsh-opencode-go-usage",
   factory: (require) => { ... } })` form, and the intermediate `lib/client.cjs`
   was deleted by `scripts/wrap-client.mjs` (`lib/` holds `client.js`,
   `client.js.map`, `index.d.ts`, `index.js`, `index.js.map`).

6. `grep -c 'sidebar.footer.action' lib/client.js` — **exit 0**, output `3`.

Additional bundle checks (not in the brief's list, recorded because they are the
client half's hard constraints): `grep -o 'require("[^"]*")' lib/client.js`
→ only `react`, `react/jsx-runtime`; `grep -c '@deepseek-ai' lib/client.js`
→ `0`.

## Blockers / not-applicable

- **No blocker.** Nothing required a path outside the writable scope; no
  `dsh.client.external` entry was needed.
- **No dedicated `admit`-throw test in `src/route.test.ts`**: that file is not in
  the brief's writable scope (only `src/cache.test.ts` was mandated for a new
  regression test), so the fix was verified with the out-of-repo scratch harness
  documented in §3 above instead. The existing 21 route tests — including the
  `admit` refusal passthrough and the 405/404/500 paths — still pass.
- **No `UsageIndicator.test.tsx`**: not in the brief's created-file list, and the
  brief's tests must not touch a real DOM. The component keeps all decisions in
  `usage-view.ts`, which is fully covered; the component itself was kept thin.
- **PLAN.md §6.4 manual live checklist not run**: it needs a running `dsh web`
  with the plugin installed, and is outside the brief's verification list.
- **Compile-time slot-contract drift guard is weaker than PLAN.md §4 anticipated**:
  the UI/slots packages are not dependencies of this package and adding them
  would require editing `package.json` (out of scope), so the client types the
  service structurally and pins the contract by the verified readings quoted
  above plus the built-bundle checks.
