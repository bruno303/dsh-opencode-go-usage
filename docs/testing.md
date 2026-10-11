# Testing `dsh-opencode-go-usage`

Two layers:

- **Automated** — six Vitest suites that run with no network and no DSH runtime. Five
  run in the default node environment; `src/client/UsageIndicator.test.tsx` opts into
  jsdom per file with a `// @vitest-environment jsdom` docblock (the global test
  environment is unchanged). Every seam (the cache clock, the upstream `fetch`, the
  provider loader, the web server, `ctx.effect`, `admit`, the client `fetch`, and the
  client clock) is injected, so the whole request lifecycle and the component's
  transport lifecycle are exercised with fakes. The browser half's *slot
  registration* is guarded at compile time instead: `pnpm run typecheck` checks it
  against the installed `dsh-client-ui-slots` / `dsh-client-ui-sidebar` declarations.
- **Manual live** — a checklist that needs a running `dsh web` and a real OpenCode
  Go key, derived from `PLAN.md` §6.4.

All commands below are the package's own scripts or explicitly named external
commands (`pnpm`, `dsh`, `curl`, `node`). Unexpected results are noted where the exit
code is easy to misread.

## Unit suites

| Suite | Covers |
|---|---|
| `src/cache.test.ts` | TTL hit/expiry, concurrent single-flight dedupe, the 5 s refresh floor, and fail-closed clearing of the cache on `key-missing` / `key-invalid` |
| `src/quota-parse.test.ts` | Window validator boundaries: `percent` 0 and 100, out-of-range and non-finite percentages, unknown `status`, `rate-limited` over a low `percent`, missing/unparseable `resetsAt`, missing window keys, extra keys ignored |
| `src/route.test.ts` | Provider error mapping (`401`/`403` → `key-invalid`, `404` → `not-found`, `5xx` → `http`, non-JSON → `parse`, transport → `network`); `admit` refusal passthrough; cached and forced reads; `405`/`404`; the snapshot-age header (including its literal, pinned through the client's own constant); the credential/raw-body leak scan; and the admission-throw guard |
| `src/index.test.ts` | The real plugin wiring: the exported plugin shape (`name` / `inject` / `apply` / `Config` defaults and overrides); `createEnvelopeLoader` against an absent, invalid, and present credential (no fetch on `key-missing`, configured URL/deadline/label on a fetch, credential never in the envelope, re-resolved per call); and `apply` with a fake `webServer`/`ctx.effect` (both routes registered under one labelled effect, disposal removes them, a colliding second registration rolls the first back, and the registered handler serves both a `key-missing` body without touching the provider and a real fetch without leaking the credential) |
| `src/client/usage-view.test.ts` | The browser half's pure view model: percentage and countdown formatting, severity grading, error copy, envelope projection, compact per-window labels for the indicator, the host-reported snapshot age (`parseServerAgeMs`, the skew-proof `fetchedAtText`, the `fetchedAt` fallback), the viewport-clamped popover placement math, and the route/header literal drift guards |
| `src/client/UsageIndicator.test.tsx` | The component's transport lifecycle in jsdom: mount load → ok render with every window on the indicator, the wide (all three windows) vs rail (binding window) split, the ticking countdown, the bounded poll with its unmount cleanup (and zero timers left), the stale marker, the host age header vs the clock fallback, fixed copy for every failure reason (server text never rendered), the POST refresh path with its in-flight disable, newest-request-wins on out-of-order responses, viewport-fixed popover placement, and no write or diagnostic after unmount |

No suite opens a socket: the only network seams are injected fakes, and
`fetchQuota` is exercised against an in-memory `Response`. They are safe to run
offline and in CI.

### Focused runs

```bash
pnpm exec vitest run src/route.test.ts          # one suite
pnpm exec vitest run src/index.test.ts
pnpm exec vitest run src/client/usage-view.test.ts
pnpm exec vitest run src/client/UsageIndicator.test.tsx
pnpm exec vitest run -t 'drift guard'           # one test by name
```

### Why `vitest.config.ts` exists

Test discovery is confined to this package. The repository that built this plugin
keeps orchestrator artifacts under `.agents/plans/`, including *snapshot copies of
test files from earlier revisions*; the default test-file glob would collect those
stale copies and report phantom `Cannot find module './cache.js'` failures from
directories that are not part of the build. `vitest.config.ts` therefore extends the
built-in excludes with `**/.agents/**`, keeping the run at **exactly six files**:

```bash
pnpm exec vitest run
#  ✓ src/cache.test.ts
#  ✓ src/index.test.ts
#  ✓ src/quota-parse.test.ts
#  ✓ src/client/UsageIndicator.test.tsx
#  ✓ src/client/usage-view.test.ts
#  ✓ src/route.test.ts
#  Test Files  6 passed (6)
```

If a seventh file appears that you did not add on purpose, it is a stray copy
somewhere outside `src/` — move or delete it rather than widening the exclude.

## Full gates

```bash
pnpm install          # external command; installs the pinned peers/dev-deps
pnpm run typecheck    # tsc --noEmit — the peer/slot contract drift guard
pnpm run test         # vitest run --passWithNoTests
pnpm run build        # tsdown + scripts/wrap-client.mjs
pnpm run verify       # typecheck && test && build
pnpm run clean        # rm -rf lib coverage — deletes build output
```

`pnpm run verify` is the one command that must pass before any change is considered
done. `pnpm run typecheck` is not cosmetic: the dev-dependencies pin the installed
DSH peers (`dsh-host-webserver`, `dsh-client-connection`, `dsh-credentials`,
`dsh-client-ui-sidebar`, `dsh-client-ui-slots`), so a future DSH release that changes
the `admit()` signature, the `WebRoute` shape, or the `sidebar.footer.action` slot
contract fails here instead of at runtime. The browser half's registration in
`src/client/index.tsx` is typed against those installed declarations (`SlotCore['register']`
plus the sidebar's merged `SlotMap`), which is why the two `dsh-client-ui-*` packages
are dev-dependencies even though the bundle never requires them.

> `pnpm run clean` removes `lib/`. Always re-run `pnpm run build` (or
> `pnpm run verify`) afterwards; an unbuilt package has no host half and no browser
> bundle for DSH to load.

## Build assertions

`pnpm run build` must emit the artifacts DSH resolves. The **four** required by the
manifest are asserted by:

```bash
for f in lib/index.js lib/index.d.ts lib/client.js lib/client.js.map; do
  test -f "$f" || { echo "MISSING $f"; exit 1; }
  echo "present $f"
done
```

Expected output (the build also emits `lib/index.js.map`, which is why `lib/`
contains five files):

```
present lib/index.js
present lib/index.d.ts
present lib/client.js
present lib/client.js.map
```

The loop exits nonzero on the first missing artifact, so it works as a gate.

`lib/client.js` is wrapped by `scripts/wrap-client.mjs` into DSH's browser module
facade, and the wrapper is part of the contract — assert it:

```bash
head -c 40 lib/client.js
# window.__ModuleLoader__.load({
# 	id: "dsh

grep -c '@deepseek-ai/' lib/client.js
# 0     ← expected; note grep exits 1 when the count is 0

grep -oE 'require\("[^"]+"\)' lib/client.js | sort -u
# require("react")
# require("react/jsx-runtime")
```

Three properties this pins, each a real failure mode:

1. **The wrapper ran.** The file must begin with `window.__ModuleLoader__.load({`
   — a raw CJS bundle was not wrapped and the browser facade cannot load it.
2. **No host package leaked into the browser bundle.** `@deepseek-ai/*` is not
   resolvable in the browser module graph; any such `require` would fail at load.
   This covers the browser entry's type-only drift-guard imports
   (`@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-sidebar/client`),
   which exist purely to fail `typecheck` and must be erased at build time. It also
   proves the node-side drift-guard import in `src/client/usage-view.test.ts` (which
   imports `src/route.ts`) stayed out of the bundle: a test file is not an entry
   point, but this checks it rather than assuming it.
3. **Only the two platform-baseline modules are externalised.** The browser facade
   resolves `react` and `react/jsx-runtime` only — there is no `dsh.client.external`
   escape hatch, so anything else must be bundled, not required.

## Manual live checklist

Requires a running GUI (`dsh web`) with the plugin installed
([docs/install.md](install.md)) and a real OpenCode Go credential. **Not executed
while writing this document** — no live profile was touched.

### 0. Compare against the upstream endpoint directly

The plugin's reading must agree with what the provider reports. This prints the
percent-only body; it never prints the key:

```bash
curl -sS \
  -H "Authorization: Bearer $OPENCODE_GO_API_KEY" \
  https://opencode.ai/zen/go/v1/usage | head -c 400
```

Expected shape (values are volatile; only the shape is contractual):

```json
{"usage":{"rolling":{"status":"ok","percent":1,"resetsAt":"…"},
          "weekly":{"status":"ok","percent":19,"resetsAt":"…"},
          "monthly":{"status":"ok","percent":30,"resetsAt":"…"}}}
```

Uses the shell's `$OPENCODE_GO_API_KEY`, or whatever name is set in `apiKeyEnv` — a
placeholder, never a literal. **Do not add `-v`, `--trace`, or `--trace-ascii`** to
this call: those print request headers, including `Authorization`. The full contract
and its evidence are in
[opencode-go-usage-api.md](opencode-go-usage-api.md).

### 1. The widget renders

The indicator appears at the **sidebar foot** (wide sidebar and collapsed rail), and in
the wide sidebar it carries all three windows as `5h 1% · wk 19% · mo 30%` — check
those numbers against step 0 *before* opening anything. Collapse the sidebar: the 56px
rail keeps only the binding window's percentage beside the dot. The popover lists the
three windows with a reset countdown each, matching the `resetsAt` values from step 0.

Leave the popover open: the reset countdown and the **Updated … ago** line advance on
their own (a one-second client tick — no reload), and the reading itself is re-read
roughly once a minute while the widget is mounted (`pollMs`, default 60 s, one `GET`
to the plugin's own route; the host TTL is what keeps that from reaching the
provider). The host's `X-Usage-Snapshot-Age-Ms` header is what the "Updated …" line
shows, so it stays correct even if the browser clock disagrees with the server's.

### 2. Refresh is throttled, not amplified

Click **Refresh**: the reading updates. Click it twice in rapid succession: the host
serves the current reading for the second click instead of making a second provider
request — the anti-spam floor is **5 s** (`DEFAULT_MIN_REFRESH_MS`), and the popover
keeps the previous snapshot rather than blanking.

### 3. `key-missing` names the reference

Unset the reference — remove it from the credential store, or start the harness
without the environment variable — then restart `dsh web`. The popover reports that
no key is configured **and names the `apiKeyEnv` reference**, never a value.

### 4. Provider failures are classified

Point `usageUrl` at a local fixture and reload:

- a fixture answering `401` → the widget reports the key was rejected
  (`key-invalid`), and any cached reading is dropped;
- a fixture answering a `rate-limited` window → alert styling and the
  `limitReached` state;
- a fixture answering non-JSON → `parse`, with the last good snapshot still shown
  and marked **stale**.

### 5. No unauthenticated reads

```bash
curl -i http://127.0.0.1:3080/__dsh_opencode_go_usage__/usage
```

Expected: `401`/`403`. The status comes from the browser-trust admission check and is
passed through verbatim. A `200` here is a bug: it means the route is readable
without a session.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No indicator at the sidebar foot | The bundle is **not selected** (the dependency is installed but `dsh.profile.bundles` does not list `dsh-opencode-go-usage`) | Check `dsh --profile web --dump-config` for the row, or the **Plugins** page; select the bundle. See [docs/install.md](install.md#manual-fallback) |
| No indicator, row *is* composed | `lib/client.js` missing — the package was installed without building | `pnpm run build` in the package, then restart/reload |
| No indicator after a successful install | A running profile did not recompose (no HMR), or the client module graph was not reloaded | Restart `dsh web`. Package *replacements* always need a fresh process |
| Route answers `401`/`403` | The request has no valid browser session (no session cookie), or it came from an origin the host does not trust | Call the route from the loaded GUI; for a remote origin review the host's browser-trust settings (loopback / trusted hosts) |
| Popover says no API key is configured (`key-missing`) | The reference named by `apiKeyEnv` is absent from `$DSH_HOME/.credentials.yaml` → `refs`, is empty, or `apiKeyEnv` is not a valid reference name | Confirm presence without printing the value ([docs/install.md](install.md#confirm-the-reference-is-present-without-printing-the-secret)), then store the key or fix the name |
| Popover says the configured key was rejected (`key-invalid`) | The provider answered `401`/`403`: revoked, expired, or wrong key | Rotate the stored key; the next fetch picks it up with no restart. The cached reading is dropped, not served |
| Popover says the usage endpoint was not found (`not-found`) | The provider answered `404`: `usageUrl` is wrong, or the undocumented endpoint moved | Re-check `usageUrl` (default `https://opencode.ai/zen/go/v1/usage`). `/zen/go/v1/quota` is a 404 and must not be used |
| Popover says the usage response could not be read (`parse`) | The upstream shape drifted (no window survived validation) | Compare with the contract in [opencode-go-usage-api.md](opencode-go-usage-api.md); the last good reading stays visible with `stale: true` |
| A **stale** marker is shown | The endpoint was unreachable or unreadable on the last attempt; the previous snapshot is still being served | Transient: the next fetch clears it. Persistent: check connectivity/proxy for the host running DSH |
| Refresh does nothing and there is no reading at all | The refresh floor (5 s) has not elapsed and nothing successful has ever loaded; the route answers `{"ok":false,"reason":"http","message":"refresh is throttled; no reading is available yet"}` | Wait out the floor and click again; if it persists, the first load is failing — check the failure reason above |
| `pnpm exec vitest run` reports more than six files | Stale test copies under `.agents/` (or another stray test outside `src/`) | `vitest.config.ts` already excludes `**/.agents/**`; if it still happens, the extra file is somewhere else — move it under `src/` |
| `pnpm run typecheck` fails on a slot or `admit()` signature | Installed DSH peers moved outside the declared range (`>=0.1.7-rc.1 <0.3.0`) | Align the dev-dependency versions with the DSH runtime, then re-run `pnpm run verify` |
| A component test fails with `document is not defined` | The `// @vitest-environment jsdom` docblock was dropped from `src/client/UsageIndicator.test.tsx` | Restore the first line of that file; jsdom is enabled per file, not globally |
