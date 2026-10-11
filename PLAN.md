# Plan: `dsh-opencode-go-usage` — DeepSeek Harness web usage plugin

Status: **ready to implement — decisions locked.** Data source verified live; scope = opencode-go only, quota percentages only (no dollars).

---

## 1. Goal

A DSH **web client plugin** that shows the **usage of the API key the harness already uses**, as a **compact status widget** in the `dsh web` GUI (icon button in the sidebar foot + detail popover).

Verified scope: the provider is **OpenCode Go** (`opencode.ai/zen/go`, a subscription plan reached through `dsh-llm-pi-ai` as route `opencode-go`). Its usage is reported as **quota windows** — rolling / weekly / monthly — each with a percent-used and a reset time, from an official but undocumented endpoint:

```http
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_GO_API_KEY>
```

Response (verified live against this machine, 2026-10-10 — rolling 1%, weekly 19%, monthly 30%):

```json
{ "usage": {
    "rolling": { "status": "ok", "percent": 1,  "resetsAt": "2026-10-11T01:21:36.000Z" },
    "weekly":  { "status": "ok", "percent": 19, "resetsAt": "2026-10-12T00:00:00.000Z" },
    "monthly": { "status": "ok", "percent": 30, "resetsAt": "2026-10-23T21:44:23.000Z" } } }
```

Full contract, validation rules, error behavior, and evidence: [docs/opencode-go-usage-api.md](docs/opencode-go-usage-api.md).

**User decisions (confirmed):** data = provider account API · key = reused from harness config · UI = status widget.

## 2. Non-goals (v1)

- No local session-log token statistics (`dsh-token-meter`) — v2 candidate.
- **No dollar amounts** — verified: `/zen/go/v1/usage` returns only `status` / `percent` / `resetsAt`
  per window; `/zen/v1/usage` returns HTML, not JSON. Money is only derivable client-side as
  `tokens × catalog price` (see §8).
- No OpenCode Zen *non-go* endpoint (verified non-JSON; `usageUrl` is configurable, so it can be
  added later).
- No npm publish; install from local path / git.

## 3. Verified architecture facts

1. **Out-of-tree plugin shape** — modeled on `~/.dsh/profiles/web/node_modules/dsh-lan-guard/package.json`:
   `dsh.manifestVersion: 1`, `dsh.engines.dsh: ">=0.1.7-rc.1 <0.3.0"` (runtime is `0.2.0-rc.2`),
   `dsh.bundle.patch: "./cordis.patch.yml"` (host half; its exported Config **is** the settings form),
   `dsh.client { platform: "web", inject: [...] }` (browser half at `lib/client.js`),
   exports `"."` → `lib/index.js` and `"./client"` → `lib/client.js`, built with **tsdown**, tested with **vitest**.
2. **Host→browser data path** — no Typert/`dsh-api-remotes` artifact generation needed. Use `ctx.webServer.register()` for one exact route plus `ctx.connection.admit(request)` for browser-trust + session authentication (the sanctioned contract; the `/api` route is owned by the connection bridge). Precedent: lan-guard registers top-level `/__dsh_lan_guard__/…` routes.
3. **Route namespace** — must not sit under `/api`. Use **`/__dsh_opencode_go_usage__/usage`** and `…/refresh`; the webserver throws on duplicate paths, so collisions fail loudly at load.
4. **Key reuse without secrets in config** — `dsh-credentials` seam:
   ```ts
   const hit = await ctx.credentials.resolve(credentialRef(cfg.apiKeyEnv)) // { value, source } | undefined
   ```
   This resolves from the DSH store (verified present: `refs/OPENCODE_GO_API_KEY` in `$DSH_HOME/.credentials.yaml`, 51 chars), exactly as `dsh-llm-pi-ai` resolves it per request — so a rotated key applies to the next fetch with no restart.
5. **Browser-trust fence** — the host already applies loopback/trustedHosts + Origin checks; our handler then calls `admit()` and passes its rejection status through.
6. **Widget mount point** — `dsh-client-ui-sidebar` declares `'sidebar.footer.action'` (`kind: 'list'`, owner prop `{ wide: boolean }`) → an action button beside Settings at the sidebar foot, covering both wide and collapsed-rail layouts. (`'sidebar.settings'` is *occupied* by ui-settings — registering there would replace it; rejected.)
7. **Provider API** — as in §1. Plain `Bearer` is sufficient; the `x-opencode-session` identity header is only injected by the pi-ai adapter for chat streams, not needed here (verified). `/zen/go/v1/quota` is 404.

## 4. Design

### Server half (Cordis plugin, `lib/index.js`)

Config (schemastery → settings form; entry id `dsh-opencode-go-usage` is the storage namespace):

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | Credential reference name resolved through the seam |
| `usageUrl` | `https://opencode.ai/zen/go/v1/usage` | Quota endpoint (undocumented → configurable) |
| `displayName` | `OpenCode Go` | Widget label |
| `refreshSeconds` | `60` | Server-side TTL before another provider fetch |
| `timeoutMs` | `10000` | Per-fetch deadline (AbortSignal) |

Behavior:
- `init`: register exact `GET /__dsh_opencode_go_usage__/usage`; dispose removes it. Secrets never enter config — only the key *name*.
- Handler: `admit(request)` → pass rejection status through; then TTL check → cached snapshot; else `resolve(credentialRef(apiKeyEnv))` → `GET usageUrl` with `Bearer` + timeout → validate/parse → cache success only.
- `POST …/refresh` bypasses the TTL (popover refresh), with a small anti-spam floor (5 s).
- Window parsing (mirrors the validator in the verified third-party implementation, minus its dashboard specifics):
  a window counts only if `status ∈ {ok, rate-limited}`, `percent` finite in `[0,100]`, and `resetsAt` parses; otherwise it is dropped, not fatal.
  `percentUsed = status === 'rate-limited' ? 1 : percent/100`; `limitReached = rate-limited || percent === 100`.
  The **binding window** is the highest `percentUsed`; its reset is the headline countdown.
- Result envelope (never contains the key):
  ```jsonc
  { "ok": true, "snapshot": {
      "label": "OpenCode Go", "fetchedAt": "2026-10-10T…Z", "stale": false,
      "limitReached": false,
      "binding": "monthly",
      "windows": [ { "id": "rolling", "label": "5h", "status": "ok",
                     "percentUsed": 0.01, "resetsAt": "…" }, … ] } }
  { "ok": false, "reason": "key-missing" | "key-invalid" | "not-found" | "network" | "parse" | "http",
    "status": 401, "message": "…" }
  ```
  Provider `401/403` → `key-invalid` and the cached snapshot is dropped; `404` → `not-found` (names `usageUrl`); malformed JSON → `parse`; transport failure → `network`. On `network`/`parse` the last good snapshot is still served with `stale: true`.

### Client half (`lib/client.js`)

- React entry registering `UsageIndicator` into `sidebar.footer.action`; inject lists `dsh-client-ui-renderer`, `dsh-client-ui-layout`, `dsh-client-ui-sidebar`, `dsh-client-ui-theme`.
- Compact indicator: a small ring/bar for the **binding window** + percent; color shifts as it approaches 100% and switches to an alert state on `limitReached`.
- Popover: one row per window (label, percent-used bar, `resetsAt` as a relative countdown), `fetchedAt`, a `stale` marker, error text for `key-missing` (names the env ref, never a value) / `key-invalid`, and a Refresh button (POST).
- Collapsed rail (`wide === false`): icon only, percent on hover/title.
- Plain same-origin `fetch` with the session cookie; no new transport machinery.

### Drift guard

Dev-deps pin the installed peers (`dsh-host-webserver`, `dsh-client-connection`, `dsh-credentials`, `dsh-client-ui-sidebar`, `dsh-client-ui-slots`, `cordis`, `schemastery`) so a future installed-version change fails **typecheck** on slot contracts or `admit()` signatures.

## 5. File-by-file plan (new repo at `/home/bruno/dev/projects/dsh-opencode-go-usage`)

| File | Contents |
|---|---|
| `package.json` | name `dsh-opencode-go-usage`, `type: module`, `dsh` manifest (§3.1), exports, peers, scripts (`build`, `typecheck`, `test`, `verify`, `prepack`) |
| `tsconfig.json` | strict, `NodeNext`, ESM |
| `tsdown.config.ts` | entries: `index` (Node + dts + sourcemap), `client` (browser bundle, injected packages external) |
| `cordis.patch.yml` | `- insert: - id: dsh-opencode-go-usage, name: dsh-opencode-go-usage` |
| `src/wire-types.ts` | shared envelope/snapshot types (node-safe) |
| `src/quota-parse.ts` | pure validator + window mapping (§4 rules) |
| `src/quota-provider.ts` | authenticated fetch + error classification (url, key, signal → envelope) |
| `src/cache.ts` | TTL cache, single in-flight dedupe, refresh floor (clock injected) |
| `src/index.ts` | Cordis plugin: Config schema, route registration, `admit()`, service wiring |
| `src/client/index.ts` | slot registration (`sidebar.footer.action`) |
| `src/client/UsageIndicator.tsx` | indicator + popover |
| `src/quota-parse.test.ts` | validator boundary cases (see §6) |
| `src/cache.test.ts` | TTL hit/expiry, concurrent dedupe, refresh floor |
| `src/route.test.ts` | admit passthrough, ok envelope, 401 cache drop, **secret-leak scan** |
| `src/client/UsageIndicator.test.tsx` | state rendering with mocked fetch |
| `docs/opencode-go-usage-api.md` | ✅ written — verified API contract + evidence |
| `README.md`, `LICENSE` (MIT) | install/usage/config docs |

## 6. Test & verification strategy

1. **Unit (vitest)**
   - `quota-parse`: valid payload; `percent` 0 and 100; `percent` out of range / non-finite; unknown `status`; `rate-limited` overriding a low `percent`; missing `resetsAt`; unparseable `resetsAt`; missing window keys; extra unknown keys ignored.
   - `cache`: TTL hit serves without fetch; expiry refetches; concurrent callers share one in-flight request; refresh floor; 401 clears the entry.
   - `route`: `admit` rejection status passthrough; ok envelope; `key-missing` when the ref resolves to nothing; **assert the resolved key never appears anywhere in the response**; `not-found` for 404.
2. **Build check**: `pnpm run build` → `lib/index.js`, `lib/index.d.ts`, `lib/client.js`, `lib/client.js.map`; a missing client bundle makes DSH fail activation loudly, so assert artifacts exist.
3. **Typecheck** against pinned installed peers (drift guard, §4).
4. **Manual live checklist** (`dsh web` running):
   - Widget appears at the sidebar foot; popover shows three windows with reset countdowns matching `/v1/usage`.
   - Refresh button re-fetches; two rapid clicks produce one provider call.
   - Revoke the ref (`unset`) → restart → `key-missing` names the env ref.
   - Point `usageUrl` at a fixture returning `401` → `key-invalid`; at a fixture returning `rate-limited` → alert styling and `limitReached`.
   - `curl -i http://127.0.0.1:<port>/__dsh_opencode_go_usage__/usage` without the session cookie → 401/403 (no unauthenticated reads).
5. **Boot audit**: `dsh --profile web --dump-config` composes the plugin row; startup reports a clean load.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Endpoint is official but **undocumented** — may move or change shape | `usageUrl` configurable; tolerant per-window validation (drops bad windows rather than failing); `404`/`parse` surfaced explicitly; contract + evidence recorded in `docs/` |
| Quota response could change field names | parsing isolated in `quota-parse.ts` with fixture tests |
| Key leakage | key resolved host-side only, never logged, never in a response; leak-scan test; config holds only the ref name |
| Key rotation | resolved per fetch through the credential seam — no restart |
| Provider rate-limiting / hammering | 60 s server TTL + refresh floor; the browser never calls the provider |
| Slot contract drift across DSH versions | peer range `>=0.1.7-rc.1 <0.3.0`; typed against pinned dev-deps; compatibility table like lan-guard |
| Plugin installed but bundle not selected | install via the Web **Plugins page** (auto-selects the bundle) or `dsh plugin --profile web add <spec>` + bundle selection; verify with `--dump-config` |

## 8. Decisions & remaining questions

1. ~~Scope: opencode-go only or also DeepSeek?~~ **Decided: opencode-go only.** The provider adapter stays as the extension seam.
2. ~~Dollar amounts?~~ **Decided: no dollars.** The quota API returns none, and an estimate would be
   list-price, DSH-attributed only, and not what the subscription bills — so v1 shows quota
   percentages and reset times only. If wanted later, the estimate is computable host-side as
   `uncachedInput·in + output·out + cacheRead·cacheRead + cacheWrite·cacheWrite` from DSH session
   token counts (via `dsh-token-meter`) and the pi-ai catalog prices (e.g. `deepseek-v4.1-flash`
   0.15 / 0.60 / 0.003 / 0, `glm-5.3-flash` 0.15 / 0.50 / 0.03 / 0 per million tokens).
   Alternative source: opencode's own DB (`~/.local/share/opencode/opencode.db` keeps per-session
   `cost` + token columns), which is another tool's data rather than DSH usage.
3. Publish to npm later, or keep local-path/git install? Non-blocking: v1 installs from a local
   path (`prepack` is already planned for a later publish).

## 9. Implementation order

1. Scaffold package + manifest + build config; `lib` artifacts build.
2. Server half: wire types → parser → provider → cache → route/plugin; unit tests.
3. Client half: slot registration + indicator/popover; component test.
4. Install into the `web` profile; run the manual checklist (§6.4).
