# Final consolidated fix report — `dsh-opencode-go-usage`

Status: **COMPLETE — all of F1–F6 resolved and verified.** Single consolidated fix
pass; no further review round. Every verification command in the brief was run in this
workspace and its real observed result is recorded below.

Baseline: the pre-fix tree is snapshotted at
`.agents/plans/snapshots/final-fix-before` with a SHA-256 manifest. A hash comparison
of the current tree against that manifest shows exactly the brief's writable scope
changed and nothing else (details in "Scope compliance").

---

## 1. Changed paths

Modified (all inside the brief's writable scope):

| Path | Why |
|---|---|
| `src/client/UsageIndicator.tsx` | F1 (ticking clock + bounded poll + timer cleanup), F5 (consume the age header) |
| `src/client/usage-view.ts` | F5 (`UsageRead`, `parseServerAgeMs`, host-age-driven `fetchedAtText`) |
| `src/client/usage-view.test.ts` | F5 (age parsing/consumption tests) + adapted transport assertions to the new read shape |
| `src/client/index.tsx` | F2 (registration typed against the real installed slot declarations) |
| `src/index.ts` | F4 (`createEnvelopeLoader` extracted so the real credential path is testable) |
| `src/route.test.ts` | F5 (header literal pinned through the client's own constant; extra age-header cases) |
| `package.json` | F2/F3 (five dev-dependencies added) |
| `docs/testing.md` | F6 (inventory, environment notes, file counts, gates, checklist, troubleshooting) |
| `README.md` | F6 (one accuracy line on the new poll behaviour) |

Created (in scope):

| Path | Why |
|---|---|
| `src/client/UsageIndicator.test.tsx` | F3 (component/transport lifecycle, jsdom per file) |
| `src/index.test.ts` | F4 (real credential-resolution path, plugin wiring, route registration/disposal) |

Generated side effects (allowed): `lib/**`, `pnpm-lock.yaml`, `node_modules/**`.

Untouched, as required: `PLAN.md`, `docs/opencode-go-usage-api.md`, `review-*.diff`,
`.agents/plans/snapshots/**`, and every other tracked file (hash-verified, §5).

Test suite growth: **4 files / 98 tests → 6 files / 130 tests**. No existing test was
deleted or weakened; the four pre-existing suites kept all their cases and gained
two (`route.test.ts`) and eight (`usage-view.test.ts`).

---

## 2. Per-finding resolution

### F1 (medium) — relative time was frozen; no scheduled refresh

**Concrete change** (`src/client/UsageIndicator.tsx`):

- Added a ticking clock as *state*: `const [nowMs, setNowMs] = useState(() => (now ?? Date.now)())`
  plus an effect that re-reads the injected clock every `TICK_MS` (1000 ms) and clears
  its interval on unmount (and on a clock-seam swap). The view is now computed at
  render time (`describeEnvelope(read?.envelope, nowMs, read?.serverAgeMs)`) instead of
  being memoised on `[envelope, now]` with `now` undefined in production — that
  memoisation is exactly why the countdown never moved.
- Added a bounded periodic `GET`: the mount-load effect now also installs a poll
  (`pollMs`, exported default `DEFAULT_POLL_MS = 60_000`) that calls the same
  `request('GET')` path, so the host's `refreshSeconds` TTL and single-flight cache
  dedupe upstream calls. `pollMs = 0` (or any non-finite value) disables polling; the
  guard is written `!(pollMs > 0)` so a NaN interval can never become a tight loop.
- Both timers are cleared in their effect cleanups; the existing `mounted` ref still
  gates every state write, so nothing is written after unmount.
- `usage-view.ts` stayed pure — it owns no timers; the component owns all of them.
- The manual **Refresh** button (POST) is unchanged.

**Tests that now cover it** (`src/client/UsageIndicator.test.tsx`):

- `advances the reset countdown as the clock ticks` — opens the popover with a
  `resetsAt` 30 s out, advances 5 × 1 s of fake timers, asserts the text moved from
  `resets in 30s` to `resets in 25s`.
- `polls the usage route on the configured interval and stops on unmount` — one GET on
  mount, a second after the interval, none after unmount, and `vi.getTimerCount()`
  is `0`.
- `uses the default poll period when none is given` pins `DEFAULT_POLL_MS === 60_000`.

Mutation probe: replacing the tick's state write with a no-op makes
`advances the reset countdown as the clock ticks` fail (verified, then reverted).

### F2 (medium) — compile-time slot-contract drift guard not implemented

**Concrete change:**

- `package.json`: added `@deepseek-ai/dsh-client-ui-sidebar` and
  `@deepseek-ai/dsh-client-ui-slots` at `0.2.0-rc.2`, the versions read from the
  installed runtime's own `package.json` under
  `/home/bruno/.nvm/versions/node/v24.14.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`.
- `src/client/index.tsx`: the local structural stand-ins are gone.
  `slots.register` is typed as `SlotCore['register']` — the installed registry's own
  signature (`SlotRegistry` declares `readonly register: SlotCore['register']`,
  "one authority, no structural copy"), which is what makes the registration options
  declaration-checked. The slot key is checked against the real merged `SlotMap`
  (`inject(key: keyof SlotMap & string, …)`), and the sidebar's client entry supplies
  the `declare module '@deepseek-ai/dsh-client-ui-slots'` augmentation for
  `'sidebar.footer.action'`. An `Expect<SidebarFooterActionOwnerProps extends
  UsageIndicatorProps ? true : false>` assertion additionally pins the component's
  props against the owner share the sidebar actually passes (needed because every prop
  is optional and would otherwise absorb a rename silently).
- All `@deepseek-ai/*` imports in the browser entry are `import type`, erased at build
  time. Re-verified: `lib/client.js` still requires only `react` and
  `react/jsx-runtime`, contains **0** occurrences of `@deepseek-ai/`, and keeps the
  `window.__ModuleLoader__.load({ id: "dsh-opencode-go-usage", factory: (require) => {`
  shape.

**Tests/checks that now cover it:** `pnpm run typecheck` (the guard is compile-time).
Two mutation probes were run and reverted to prove it bites:

- changing `SLOT` to `'sidebar.footer.nope'` fails with
  `Argument of type '"sidebar.footer.nope"' is not assignable to parameter of type
  '"sidebar.brand.mark" | … | "sidebar.workspaces"'` — i.e. the real `SlotMap` is
  loaded and checked;
- adding a required prop to `UsageIndicatorProps` fails with
  `src/client/index.tsx(44,3): error TS2344: Type 'false' does not satisfy the
  constraint 'true'`.

### F3 (medium) — the React component had no test

**Concrete change:**

- Created `src/client/UsageIndicator.test.tsx` (12 tests) with
  `// @vitest-environment jsdom` as its first line (per-file DOM; the global vitest
  environment is untouched).
- `package.json`: added `jsdom` (`^30.1.2`) and `@testing-library/react` (`^16.3.3`),
  plus `@testing-library/dom` (`^10.4.2`) because RTL 16 declares it as a required
  peer dependency and pnpm would otherwise only auto-install it implicitly.
- Every test injects the `fetchImpl` and `now` seams (plus `pollMs`), so there is no
  real network and no real timer left running: `afterEach` runs `cleanup()`,
  `vi.useRealTimers()` and `vi.restoreAllMocks()`.

**Coverage against the brief's list:**

| Required | Test |
|---|---|
| initial load → ok render | `loads once on mount and renders the binding window with its windows` (asserts the GET path/method and the popover rows) |
| stale marker | `marks a stale reading` (aria-label `(stale)` + popover copy) |
| each error reason's copy | `renders fixed copy for every failure reason and never server text` (all six reasons, `HTTP 418` line, and a server `message` that must never be painted) |
| POST refresh path + in-flight disable | `POSTs the refresh route, disables the button in flight, then commits the reading` (POST URL/method, `disabled`, `Refreshing…`, then `Refresh` and the new percentage) |
| response after unmount → no state write, no warning | `ignores a response that resolves after unmount without warning` |

Also added: the ticking countdown, the poll + zero timers after unmount, host age
header vs clock fallback, newest-request-wins on out-of-order responses, and the
wide/rail split.

**Note on the unmount test (handled differently, with reason):** React 18 makes a
post-unmount `setState` a *silent* no-op — it neither warns nor throws — so a test can
assert "no warning" but cannot observe "no state write" directly. The test therefore
asserts that nothing escapes after the late resolution: no `console.error`, no window
`error` event, no rejected continuation (which would fail the run), and the unmounted
widget left no DOM behind. The *same* `mounted`/`ticket` guard logic is pinned
behaviorally by the new `lets only the newest request commit when responses arrive out
of order` test, which **was verified to fail** when the ticket check is removed.

### F4 (medium) — the real credential-resolution path was untested

**Concrete change** (`src/index.ts`, minimal refactor, exported plugin shape unchanged):

- Extracted `createEnvelopeLoader(config, deps)` (with exported `UsageLoaderConfig` and
  `EnvelopeLoaderDeps`), which owns the real logic: `isCredentialRefName` guard →
  `key-missing` without touching the seam; `resolveCredential(credentialRef(name))`
  → `undefined` → `key-missing` naming the reference; otherwise
  `fetchQuota({ url, apiKey, timeoutMs, label, now })`. The credential value is never
  captured in module state and never copied into an envelope.
- `apply()` now wires the real dependencies into it:
  `{ resolveCredential: (ref) => ctx.credentials.resolve(ref) }` and the real
  `fetchQuota`. `name`, `inject`, `Config` and `apply` are byte-for-byte the same
  public surface (`lib/index.d.ts` exports `Config`, `EnvelopeLoaderDeps`,
  `UsageLoaderConfig`, `apply`, `createEnvelopeLoader`, `inject`, `name`).

**Tests that now cover it** (`src/index.test.ts`, 10 tests):

- plugin shape: `name`, `inject`, `Config(undefined)` defaults, and operator overrides;
- `createEnvelopeLoader`:
  - an invalid `apiKeyEnv` (a pasted `Bearer sk-…`) → `key-missing`, **no** resolve
    call, **no** fetch, and the pasted value is not echoed;
  - an absent credential → `key-missing` naming the reference, **no** fetch;
  - a present credential → resolve called with `credentialRef('OPENCODE_GO_API_KEY')`,
    the provider fetch called with the configured `usageUrl`, `timeoutMs` and
    `displayName`, `Authorization: Bearer <fake>`, an `AbortSignal`, and an envelope
    whose JSON contains neither the value nor `Bearer`;
  - re-resolution per call (a rotated value reaches the next fetch);
- `apply` with a fake `webServer`/`ctx.effect` (practical without a live runtime, so it
  was done rather than deferred):
  - both exact routes registered under one effect labelled
    `dsh-opencode-go-usage quota routes`, and disposal removes both;
  - a colliding second registration rejects `apply` **and rolls the first route back**;
  - driving the registered handler: an absent credential serves the `key-missing`
    envelope through the real route without touching the provider, and a present
    credential fetches with the configured URL and returns a body (and headers) that
    contain neither the credential nor its `Authorization` header.

### F5 (low) — `X-Usage-Snapshot-Age-Ms` was produced but never consumed

**Concrete change — consumed, not removed:**

- `usage-view.ts` exports `SNAPSHOT_AGE_HEADER` and a new `UsageRead`
  (`{ envelope, serverAgeMs? }`). `requestUsage` reads the header before the body and
  returns the host-reported age alongside the envelope;
  `fetchUsage`/`refreshUsage` now resolve to `UsageRead`.
- `parseServerAgeMs(raw)` accepts only a plain, non-negative, finite number (trimmed);
  anything else (`null`, empty, `12ms`, `NaN`, `-1`) yields `undefined`, which selects
  the `fetchedAt` fallback rather than printing a wrong age.
- `describeEnvelope(envelope, nowMs, serverAgeMs?)`: when the host reported an age, the
  "Updated …" text is derived from it (clamped at 0); otherwise it falls back to
  `now - fetchedAt` exactly as before. This is what actually handles the
  browser/server clock-skew case the header exists for.
- The component stores the whole `UsageRead` and passes the age through.
- The host header name is now pinned from **both** sides: `usage-view.test.ts` pins the
  client literal, and `src/route.test.ts` imports `SNAPSHOT_AGE_HEADER` from the client
  module and asserts the host response carries that exact header (plus the
  negative-clamp and unparseable-`fetchedAt` cases).

**Tests that now cover it:** `parseServerAgeMs` (2 tests), `prefers the host-reported
age over the browser clock (skew guard)`, `clamps a negative host-reported age to just
now`, `keeps the fetchedAt fallback for every age bucket`, the two new
`fetchUsage`/`refreshUsage` header tests in `usage-view.test.ts`, the two component
tests (`uses the host-reported snapshot age so clock skew cannot lie about staleness`,
`falls back to the browser clock when the host sends no age`), and the three
age-header cases in `route.test.ts`.

### F6 (docs consistency)

- `docs/testing.md`: rewritten inventory (six suites, with the new
  `src/index.test.ts` and `src/client/UsageIndicator.test.tsx` rows), the environment
  note (five node suites + one jsdom-per-file docblock), the file-count statements
  ("exactly six files", sample `vitest run` output, focused-run examples, the
  troubleshooting row), the typecheck gate (now names the two `dsh-client-ui-*`
  dev-dependencies and what they guard), the build-assertion note (the browser entry's
  type-only imports are erased and the `0` `@deepseek-ai/` count covers them), the live
  checklist step 1 (countdown/updated line tick without a reload; the reading is
  re-read roughly once a minute; the age header keeps "Updated …" correct under clock
  skew), and a new troubleshooting row for a missing jsdom docblock.
- `README.md`: one line only. Every README claim is now accurate after F1–F5
  (notably "a live countdown to each reset"), so the sole edit clarifies the
  `refreshSeconds` row: the browser never calls the provider, the widget re-reads the
  plugin's own route about once a minute, and the TTL decides whether that read
  reaches the provider.

---

## 3. Verification commands and observed results

Run from `/home/bruno/dev/projects/dsh-opencode-go-usage` (not a git repository; no git
commands were used).

### `pnpm install`

```
Already up to date
Done in 2ms using pnpm v12.10.1
exit=0
```

**Sandbox note (environment, not a project change):** the *first* install after adding
the five dev-dependencies failed with
`ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK … Failed to open the store operation lock at
"pnpm-store-operation-locks": Read-only file system (os error 30)`. An `LD_PRELOAD`
path trace showed pnpm creates that lock under `$XDG_RUNTIME_DIR`, i.e.
`/run/user/1002/pnpm-store-operation-locks-1002`, which is outside the session
workspace and denied by the DSH file sandbox (real `EROFS`; writes under the workspace
and `/tmp` succeed). The install was completed with
`XDG_RUNTIME_DIR="$PWD/node_modules/.pnpm-home/run" pnpm install --store-dir "$PWD/node_modules/.pnpm-store/v11"`
(the same store dir already recorded in `node_modules/.modules.yaml`), which reported
`+52 -1` packages and the five new dev-dependencies. No project file was changed to
work around this, and the plain command above now reports success because the tree is
in sync.

### `pnpm exec vitest run`

```
 ✓ src/cache.test.ts (22 tests) 10ms
 ✓ src/quota-parse.test.ts (21 tests) 11ms
 ✓ src/route.test.ts (24 tests) 34ms
 ✓ src/client/usage-view.test.ts (41 tests) 37ms
 ✓ src/index.test.ts (10 tests) 38ms
 ✓ src/client/UsageIndicator.test.tsx (12 tests) 415ms
 Test Files  6 passed (6)
      Tests  130 passed (130)
```

(The order of files in the report varies between runs; the counts are stable. The
suite was run four times in total, all green, to check the timer/`act` tests for
flakiness.)

### `pnpm run typecheck`

```
$ tsc --noEmit
exit=0
```

This now covers the real slot types: both F2 mutation probes fail here (see F2).

### `pnpm run build`

```
$ tsdown && node scripts/wrap-client.mjs
ℹ  [CJS] lib/client.cjs      23.08 kB │ gzip:  7.70 kB
ℹ  [CJS] lib/client.cjs.map  42.11 kB │ gzip: 13.61 kB
✔  Build complete in 59ms
ℹ  [ESM] lib/index.js      16.45 kB │ gzip:  5.75 kB
ℹ  [ESM] lib/index.js.map  38.13 kB │ gzip: 12.31 kB
ℹ  [ESM] lib/index.d.ts     8.06 kB │ gzip:  3.02 kB
✔  Build complete in 171ms
[wrap-client] wrote lib/client.js (id: dsh-opencode-go-usage, body offset 5 lines) and lib/client.js.map
exit=0
```

`lib/` contains exactly five files: `index.js`, `index.d.ts`, `index.js.map`,
`client.js`, `client.js.map`.

### `test -f lib/client.js && head -c 40 lib/client.js`

```
window.__ModuleLoader__.load({
	id: "dsh
exit=0
```

The facade shape is intact (`factory: (require) => {` on line 3).

### `grep -c '@deepseek-ai/' lib/client.js`

```
0
exit=1
```

`0` is the expected count; grep's exit `1` is the documented "no match" (the same
result the brief and `docs/testing.md` call out). The bundle's complete require set is:

```
require("react")
require("react/jsx-runtime")
```

### `pnpm run verify`

```
exit=0
```

(`typecheck && test && build`, all three green.)

---

## 4. Deliberate deviations / residuals

1. **`slots.inject` is typed structurally, not from `SlotRegistry`.** The real
   `SlotRegistry` declaration lives in `@deepseek-ai/dsh-client-ui-renderer`, which the
   brief did not list among the packages to add, and `register` — the part F2 names —
   is typed with the real `SlotCore['register']` (the exact signature `SlotRegistry`
   reuses). Residual: a future change to `inject`'s *callback* type alone would not fail
   `typecheck`; a change to its key domain would, because that is
   `keyof SlotMap & string` from the real merged map. If a full-fidelity guard is
   wanted later, adding `@deepseek-ai/dsh-client-ui-renderer` as a dev-dependency and
   typing `ctx.slots` as the real `SlotRegistry` closes it.
2. **The unmount assertion is expressed as "nothing escapes".** Explained in F3: React
   18 removed the post-unmount state-update warning, so the write is unobservable by
   design. The guard logic itself is pinned by the out-of-order test, which was
   mutation-verified.
3. **No component test for `src/client/index.tsx` (the slot registration).** Not
   requested by the brief, and it would need a live renderer; F2's guard is
   compile-time, which is what `PLAN.md` §4 and `docs/testing.md` promise.
4. **`pnpm install` needed `XDG_RUNTIME_DIR` redirected for the first fetch.** Sandbox
   constraint only (see §3); recorded rather than worked around in project files.
5. **`README.md` was edited** even though no claim was left inaccurate. The single
   edited row documents the newly real poll behaviour next to the `refreshSeconds` TTL
   it interacts with; the brief allowed README updates.

---

## 5. Scope compliance evidence

Comparing the current tree against
`.agents/plans/snapshots/final-fix-before.manifest` (SHA-256 per file):

```
CHANGED:
   ./README.md
   ./docs/testing.md
   ./package.json
   ./pnpm-lock.yaml            ← generated side effect (allowed)
   ./src/client/UsageIndicator.tsx
   ./src/client/index.tsx
   ./src/client/usage-view.test.ts
   ./src/client/usage-view.ts
   ./src/index.ts
   ./src/route.test.ts
MISSING: none
EXTRA (new files): ./src/client/UsageIndicator.test.tsx, ./src/index.test.ts
```

That is exactly the brief's writable scope plus the two allowed new test files and the
allowed lockfile side effect. `PLAN.md`, `docs/opencode-go-usage-api.md`, the
`review-*.diff` artifacts and everything under `.agents/plans/snapshots/` are
hash-unchanged. No credential value was printed, logged, embedded, or returned at any
point in this pass; the fake tokens used in tests are obvious placeholders
(`sk-fake-not-a-real-secret-…`, `sk-should-never-render`) and appear only inside
negative assertions.
