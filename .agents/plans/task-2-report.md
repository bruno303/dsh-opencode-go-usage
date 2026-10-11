# Task 2 report — host half: parse, provider, cache, authenticated route

**Status: DONE.** All deliverables are implemented, the brief's five verification commands were run
and observed to pass, and the secret never appears in a response, a log, or an error message.

## 1. Changed paths

Created (all inside the brief's writable scope):

| Path | Contents |
|---|---|
| `src/quota-parse.ts` | Pure validator/parser for the three quota windows |
| `src/quota-provider.ts` | Authenticated `GET` with deadline + error classification (injectable `fetch`) |
| `src/cache.ts` | TTL cache, single-flight, refresh floor, stale-on-transport-failure |
| `src/route.ts` | Route constants + `createUsageHandler` (the test seam) |
| `src/quota-parse.test.ts` | 21 parser tests |
| `src/cache.test.ts` | 21 cache tests |
| `src/route.test.ts` | 21 tests: `fetchQuota` + handler + secret-leak scan |

Modified:

| Path | Change |
|---|---|
| `src/index.ts` | Cordis wiring: config → cache → credential-resolving loader → handler → two exact routes under one `ctx.effect` |
| `package.json` | `lib/index.js.map` added to `files` (Task 1 review carry-over); nothing else changed |

Not modified (allowed but not needed): `src/wire-types.ts` — Task 1's types already cover the parser
result, windows, and envelope, so no addition was required.

Generated side effects only: `lib/**`. `pnpm-lock.yaml` and `node_modules/**` were not rewritten.

## 2. Key decisions

### 2.1 Parser leniency and binding

`parseUsagePayload` drops individual invalid windows and only fails when there is no usable `usage`
object or no surviving window. Unknown top-level and per-window fields are ignored; only `rolling`,
`weekly`, `monthly` are read. The binding scan iterates shortest-window-first with a strict `>`, so
an equal `percentUsed` keeps the earlier (shorter) window — the documented tie-break — with no
separate comparison code. `rate-limited` forces `percentUsed = 1` and `limitReached = true`
regardless of `percent`. Never throws (guarded by `isRecord`), verified against symbols, functions,
`Date`, `Map`, arrays, and primitives.

### 2.2 Cache semantics (envelope-level cache)

The cache stores **success envelopes** (`Extract<UsageEnvelope, { ok: true }>`), not bare
`QuotaSnapshot`s, because `load()` resolves `UsageEnvelope` and the stale marker is a snapshot field;
`get()` therefore returns a `CachedEnvelope | undefined` that the route serves directly. The brief's
"at least" method list is implemented exactly, plus one documented extension:

* `load(loader, { force?: boolean })` — the extension. `POST …/refresh` must bypass the TTL; calling
  `clear()` first would have destroyed the previous good reading that stale-on-failure depends on.
* **Freshness**: `isFresh()` is `ageMs() < ttlMs` (strict), so a reading is stale exactly at its TTL
  boundary. `ageMs()` is `undefined` when nothing is stored.
* **Refresh floor**: `canForceRefresh()` is `now() - lastLoadStartedAt >= minRefreshMs` (default
  `5000`), with `lastLoadStartedAt` recorded when a load *starts* — so a failing load still imposes
  the floor, and `key-missing`/`key-invalid` clearing the cache does not unlock retry hammering.
  `set()` deliberately does not start the floor (a manual seed is not a provider call).
* **Stale on transport failure**: `network`/`parse` with a previous good reading resolves with that
  snapshot marked `stale: true`, keeps the original `fetchedAt`, and does **not** refresh `storedAt`
  — so the next request retries the provider instead of treating the stale copy as fresh for another
  full TTL. With no previous reading the failure propagates unchanged.
* **Fail-closed on credential failure**: `key-missing`/`key-invalid` clears the stored reading and
  propagates the failure; no stale copy is served.
* **Unspecified reasons**: `not-found`/`http` propagate the failure but keep the last good reading
  (a misconfigured or transient endpoint must not evict a good snapshot). Recorded because the brief
  only specified the `network`/`parse` and credential branches.
* A **throwing** loader is converted to `{ ok: false, reason: 'network', message: 'quota load failed' }`
  — its own message is never surfaced (it could carry the request URL or a header).

### 2.3 Admission handling

`createUsageHandler` calls `admit(req)` before any method/path dispatch or cache access. A refusal
writes exactly `admit.rejection` (401/403) with `{ ok: false, reason: 'http', status }` and returns;
the cache and provider are untouched. `PeerAdmission` is imported as a type only, so `route.ts` has no
runtime dependency on the DSH runtime (the built host bundle imports only `dsh-credentials` and
`schemastery`).

### 2.4 Route contract

* `USAGE_ROUTE`/`REFRESH_ROUTE` are absolute, slash-free, and outside `/api`.
* `GET` on the usage route: fresh → `cache.get()`; otherwise `cache.load(loadEnvelope)` (the cache —
  not the handler — owns single-flight and stale rules, so production code never bypasses them).
* `POST` on the refresh route: `canForceRefresh()` → `cache.load(loadEnvelope, { force: true })`;
  otherwise the current reading at 200 with no provider call. When the floor is active and nothing
  successful has ever loaded, a fixed throttled `{ ok: false, reason: 'http', message: … }` body is
  returned rather than calling the provider.
* Wrong method on a known path → `405` with `Allow: GET`/`POST`; an unknown path (reachable only if
  the handler is invoked directly) → `404`. Both carry no secrets.
* Every response is `application/json; charset=utf-8` with an explicit `Content-Length` and
  `Cache-Control: no-store`. Snapshot-bearing responses also carry
  `X-Usage-Snapshot-Age-Ms`, computed from the injected `now` and the snapshot's `fetchedAt` — this is
  what the brief's optional `now` dep is used for.
* A top-level `try/catch` answers any unexpected throw with a fixed `500` body (and only when headers
  have not been sent), so an internal error string can never escape.

### 2.5 Service wiring (`src/index.ts`)

The verified `inject` list and the five-field `Config` schema (names, descriptions, defaults) are
byte-for-byte Task 1's. `apply` validates the raw Loader config through `Config(...)`, builds the
cache with `ttlMs = refreshSeconds * 1000`, and registers one handler on both exact routes.

* **Credential resolution per load**: `isCredentialRefName(apiKeyEnv)` first (a name outside the
  grammar has no reference to miss, and `credentialRef` would throw), then
  `ctx.credentials.resolve(credentialRef(apiKeyEnv))` on every miss — the value is never captured in
  module state, so a rotated key applies to the next fetch. Absent → `key-missing` naming the
  reference; present → `fetchQuota`.
* **Secret safety in the wiring**: the invalid-`apiKeyEnv` message does **not** echo the configured
  value (an operator who pasted a key into that field must not see it reflected); the absent-credential
  message names the reference only, as PLAN §4 specifies.
* **Disposal mechanism**: `ctx.effect(() => { … return disposer }, label)` — the lifecycle hook
  Cordis 4.0.4 supports (`Fiber.effect(execute: () => SyncEffect, label?)`, verified in
  `@deepseek-ai/cordis/lib/types/fiber.d.ts`) and the pattern `dsh-lan-guard` uses. The returned
  disposer calls both route disposers in reverse registration order. If the second `register` throws
  (duplicate-path collision), the first route is disposed before rethrowing, so a failed activation
  leaves nothing mounted.
* Nothing is logged, so there is no log path that could carry the key or the `Authorization` header.
* The exported shape is unchanged: `lib/index.d.ts` ends with `export { Config, apply, inject, name }`.

### 2.6 `User-Agent` version source

`src/quota-provider.ts` imports `../package.json` with `with { type: 'json' }` and exports
`USER_AGENT = \`${name}/${version}\``. The build inlines the manifest (`//#region package.json` in
`lib/index.js`), so the header cannot drift from a release bump and the bundle keeps no runtime file
dependency. Verified in `lib/index.js`: `var version = "0.1.0"`.

### 2.7 Test placement for the provider

The brief's writable scope fixes the test file set to three files and does not include
`src/quota-provider.test.ts`, so `fetchQuota`'s status mapping, header construction, deadline signal,
abort classification, and `fetchedAt` clock are covered in a clearly-labelled `describe('fetchQuota')`
block inside `src/route.test.ts`. That also lets the secret-leak scan run the real provider with an
injected `fetchImpl`, i.e. through the same code path production uses. No test touches the network
(every transport is a stub) and none starts the DSH runtime (the handler's `admit` is a plain fake).

## 3. Verification (exact commands and observed results)

All commands run from `/home/bruno/dev/projects/dsh-opencode-go-usage` on the final tree.

| # | Command | Observed result |
|---|---|---|
| 1 | `pnpm exec vitest run src/quota-parse.test.ts src/cache.test.ts src/route.test.ts` | `3 passed (3)`, `63 passed (63)` — 21 parse, 21 cache, 21 route; `Duration ~0.2s` |
| 2 | `pnpm run typecheck` | `tsc --noEmit`, no diagnostics, exit 0 |
| 3 | `pnpm run build` | `tsdown` + wrapper OK: `lib/client.cjs` (intermediate, deleted), `lib/index.js 15.68 kB`, `lib/index.js.map 35.10 kB`, `lib/index.d.ts 2.74 kB`, then `[wrap-client] wrote lib/client.js (id: dsh-opencode-go-usage, body offset 5 lines) and lib/client.js.map` |
| 4 | `pnpm run test` | `3 passed (3)`, `63 passed (63)` |
| 5 | `test -f lib/client.js && head -c 40 lib/client.js` | exit 0; output `window.__ModuleLoader__.load({\n\tid: "dsh` — the browser facade wrapper is intact after the build |

Additional checks performed (not required by the brief):

* `lib/index.d.ts` exports exactly `{ Config, apply, inject, name }` (Task 1 entry contract preserved).
* `lib/index.js` runtime imports are only `@deepseek-ai/dsh-credentials` and
  `@deepseek-ai/schemastery`; `dsh-client-connection`/`dsh-host-webserver` stayed type-only.
* The manifest version is inlined in the host bundle (no `../package.json` runtime import).
* Mtime scan of the tree confirms only the brief's writable paths (plus generated `lib/**`) changed;
  `src/wire-types.ts`, `tsconfig.json`, `tsdown.config.ts`, `scripts/wrap-client.mjs`,
  `cordis.patch.yml`, and `pnpm-lock.yaml` are untouched.

## 4. Blockers / not-applicable checks

* **No blockers.** No scope expansion was needed.
* **Not applicable in this task**: the manual live checklist (PLAN §6.4), `dsh --profile web
  --dump-config` boot audit, and profile installation are Task 4/user-executed and were not attempted
  (no live DSH runtime, no real network). The client half (Task 3) is untouched.
* One environment caveat observed during the build (pre-existing, not introduced here): tsdown warns
  `TypeScript 7.0 does not yet have a stable API and is experimental. Some options will be
  unavailable.` The build still emits `.d.ts` successfully.
