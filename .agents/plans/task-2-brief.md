# Task 2 brief — host half: parse, provider, cache, authenticated route

## Context

Project root: `/home/bruno/dev/projects/dsh-opencode-go-usage` (**not a git repo** — no git commands).
Task 1 delivered the scaffold and a working two-entry build (`pnpm run build` → `lib/index.js`,
`lib/index.d.ts`, `lib/client.js`, `lib/client.js.map`). Read `PLAN.md` §4 (server half) and
`docs/opencode-go-usage-api.md` (the verified upstream contract) before coding.

Installed DSH type declarations you must use for exact signatures:
`/home/bruno/.nvm/versions/node/v24.14.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
- `dsh-host-webserver/lib/types/index.d.ts` — `WebRoute { kind: 'exact'|'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }` and `register(route): () => void`.
- `dsh-client-connection/lib/types/rpc.d.ts` + `rpc-host.d.ts` — `admit(request: ConnectionTrustRequest): PeerAdmission` ("the operator Peer it speaks for, or the status refusing it"). Read the exact `PeerAdmission` variant shape before using it.
- `dsh-credentials` — `credentialRef(name)` and `ctx.credentials.resolve(ref)` → `{ value, source } | undefined`.
- `dsh-host-webserver` README (same package dir) for route matching rules.

## Goal of this task

Implement the whole host half behind a thin, testable seam: a pure parser, an injectable fetch, a TTL
cache with single-flight, and an HTTP handler factory that Task 2's tests exercise directly.
`src/index.ts` wires them to Cordis. The API key must never appear in a response, a log, or an error
message.

## Deliverables

### 1. `src/quota-parse.ts` (pure, no I/O)
- `export function parseUsagePayload(payload: unknown): { ok: true; windows: QuotaWindow[]; binding: string | null; limitReached: boolean } | { ok: false; reason: 'parse'; message: string }`
- Window validity requires **all** of: `status` is exactly `'ok'` or `'rate-limited'`; `percent` is a
  finite number in `[0, 100]`; `resetsAt` is a non-empty string whose `Date.parse` is finite.
  Invalid or missing windows are **dropped**, not fatal.
- `percentUsed = status === 'rate-limited' ? 1 : percent / 100`
- `limitReached = status === 'rate-limited' || percent === 100`
- Window ids/labels: `rolling`→`5h`, `weekly`→`Weekly`, `monthly`→`Monthly`; iterate only these three keys.
- `binding` = id of the window with the highest `percentUsed`; ties prefer the shorter window in the
  order `rolling` > `weekly` > `monthly`. `null` when no window is valid.
- Parse failure when the payload has no usable `usage` object **or** no valid window at all.
- Extra/unknown fields are ignored. Never throw on malformed input.

### 2. `src/quota-provider.ts` (injectable fetch)
- `export async function fetchQuota(deps: { url: string; apiKey: string; timeoutMs: number; label: string; fetchImpl?: typeof fetch; now?: () => number }): Promise<UsageEnvelope>`
- `GET <url>` with `Authorization: Bearer <key>`, `Accept: application/json`, and a
  `User-Agent: dsh-opencode-go-usage/<package version>` header.
- Deadline via `AbortSignal` (`AbortSignal.timeout` is fine); treat abort/timeout and any transport
  failure as `reason: 'network'`.
- Status mapping: `401`/`403` → `key-invalid`; `404` → `not-found`; other non-2xx → `http` (include
  `status`); unparseable JSON body → `parse`.
- On success build `{ ok: true, snapshot: { label, fetchedAt: new Date(now()).toISOString(), stale: false, limitReached, binding, windows } }` from the parser result.
- **Secret safety:** error `message` fields must contain only safe facts (status code, a short reason
  phrase). Never include the key, the Authorization header, or the raw body.
- Tests must never hit the network: `fetchImpl` is the injection point.

### 3. `src/cache.ts` (pure, clock-injected)
- `export function createSnapshotCache(opts: { ttlMs: number; minRefreshMs?: number; now?: () => number })`
  with at least: `get()`, `isFresh()`, `set(snapshot)`, `clear()`, `ageMs()`, `canForceRefresh()`, and
  `load(loader: () => Promise<UsageEnvelope>): Promise<UsageEnvelope>`.
- Required behaviors (all unit-tested):
  - A fresh cached snapshot is served **without** invoking `loader`.
  - An expired snapshot invokes `loader` once.
  - Concurrent `load()` calls **share one in-flight** loader invocation (single-flight).
  - `minRefreshMs` (default `5000`) gates forced refreshes via `canForceRefresh()`.
  - When `loader` fails with `network` or `parse` **and** a previous good snapshot exists, resolve with
    that snapshot marked `stale: true`.
  - When `loader` fails with `key-missing` or `key-invalid`, `clear()` the cache and propagate the
    failure envelope (do not serve a stale snapshot).
  - Successful loads store the snapshot with `stale: false`.

### 4. `src/route.ts` (handler factory — the test seam)
- Export the route path constants: `USAGE_ROUTE = '/__dsh_opencode_go_usage__/usage'` and
  `REFRESH_ROUTE = '/__dsh_opencode_go_usage__/refresh'` (absolute, no trailing slash, **never** under `/api`).
- `export function createUsageHandler(deps: { cache; loadEnvelope: () => Promise<UsageEnvelope>; admit: (req) => PeerAdmission; now?: () => number }): (req, res) => Promise<void>`
  - Call `admit(req)` first. If the admission is a refusal, write that status code and a JSON
    `{ ok: false, reason: 'http', status }` body, and return — an unauthenticated request must never
    reach the provider or the cache.
  - `GET` on the usage route: serve the cache (fresh → cached; expired → `loadEnvelope()`).
  - `POST` on the refresh route: force a reload when `canForceRefresh()` is true, otherwise return the
    current snapshot (200) without calling the provider.
  - Any other method → `405` with `Allow` reflecting the supported method.
  - Responses are `application/json; charset=utf-8` with an explicit `Content-Length`.
  - A refusal/error body must never contain the API key or the raw upstream body.

### 5. `src/index.ts` (modified — Cordis wiring)
- Keep the verified `inject` service names and the `Config` schema from Task 1 (all five fields,
  unchanged defaults).
- In `apply(ctx, rawConfig)`: parse the config, build the cache (`ttlMs = refreshSeconds * 1000`),
  create the handler with a `loadEnvelope` that resolves the credential via
  `credentialRef(config.apiKeyEnv)` → `key-missing` when absent, otherwise calls `fetchQuota`, and
  register the two exact routes through `ctx.webServer.register(...)`.
- Ensure both route registrations are disposed when the plugin unloads (`ctx.effect(...)` or the
  returned disposers via a `dispose` handler — pick what the installed Cordis version supports and
  record the choice).
- Never log the key or the Authorization header. Keep the module's exported shape exactly as Task 1
  left it (`export { Config, apply, inject, name }`).

### 6. Tests
- `src/quota-parse.test.ts` — valid three-window payload; `percent` 0; `percent` 100 → `limitReached`;
  out-of-range / non-finite `percent` dropped; unknown `status` dropped; `rate-limited` with a low
  `percent` → `percentUsed === 1` and `limitReached`; missing `resetsAt`; unparseable `resetsAt`;
  missing window keys; all-invalid → `parse` failure; unknown extra keys ignored; binding selection
  including the tie-break.
- `src/cache.test.ts` — every behavior listed in §3, with an injected clock and a counting loader.
- `src/route.test.ts` — refusal passthrough (401/403) with no provider call; GET fresh-cache hit;
  GET miss loads once; POST refresh respects the floor; 405 on a wrong method; and a **secret-leak
  scan** asserting the fake key string never appears in any response body.
- Use `vitest`. Do not use the real network or the real DSH runtime in tests.

### 7. Carry-over fix (small, from the Task 1 review)
- `package.json`: add `lib/index.js.map` to the `files` array so the shipped host bundle's
  `//# sourceMappingURL=index.js.map` resolves inside the packed tarball. Change nothing else there.

## Conventions

- TypeScript strict, ESM, `import type` for types; no unjustified `any`.
- Pure modules stay free of `node:http`/Cordis imports so they are trivially testable.
- Comments explain *why* where behavior is non-obvious (validation leniency, stale-on-failure,
  secret safety); do not narrate the obvious.
- Never weaken a test to make it pass; a failing expectation is a real finding.

## Verification (run these; record exact commands and observed results)

```bash
pnpm exec vitest run src/quota-parse.test.ts src/cache.test.ts src/route.test.ts
pnpm run typecheck
pnpm run build
pnpm run test        # full suite must pass
test -f lib/client.js && head -c 40 lib/client.js   # client bundle still valid after the build
```

## Writable scope (only these paths)

Created: `src/quota-parse.ts`, `src/quota-provider.ts`, `src/cache.ts`, `src/route.ts`,
`src/quota-parse.test.ts`, `src/cache.test.ts`, `src/route.test.ts`.
Modified: `src/index.ts`, `src/wire-types.ts`, `package.json`.

Allowed generated side effects (excluded from review): `lib/**`, `pnpm-lock.yaml`, `node_modules/**`.
Report path (also allowed): `.agents/plans/task-2-report.md`.

If you need any other path, stop and reply exactly
`BLOCKED: SCOPE_EXPANSION: <path> — <reason>` instead of editing it.

## Report (final step — mandatory)

Write `.agents/plans/task-2-report.md`: status, changed paths, key decisions (cache semantics,
admission handling, disposal mechanism, service wiring), the exact verification commands with
observed results, and any blocker or not-applicable check.
