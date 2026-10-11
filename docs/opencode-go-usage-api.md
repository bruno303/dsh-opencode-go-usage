# OpenCode Go usage API — verified contract

Research date: 2026-10-10. Verified **live** against this machine's credential
store entry `OPENCODE_GO_API_KEY` (DSH credentials, `$DSH_HOME/.credentials.yaml`).

## Endpoint

```http
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_API_KEY>
```

- Returns `200` with quota windows for the subscription.
- **No** workspace id, **no** auth cookie, **no** SSR scraping.
- **No** `x-opencode-session` header needed (verified: that header is only injected by
  `dsh-llm-pi-ai` for *chat* streams via `withOpenCodeSessionHeader`; the identity
  header note applies to chat requests that would otherwise 403).
- `GET /zen/go/v1/quota` returns **404** — do not use it.

## Response shape

```json
{
  "usage": {
    "rolling": { "status": "ok", "percent": 1,  "resetsAt": "2026-10-11T01:21:36.000Z" },
    "weekly":  { "status": "ok", "percent": 19, "resetsAt": "2026-10-12T00:00:00.000Z" },
    "monthly": { "status": "ok", "percent": 30, "resetsAt": "2026-10-23T21:44:23.000Z" }
  }
}
```

Observed live values on 2026-10-10 (rolling 1%, weekly 19%, monthly 30%). Values are
volatile; only the shape is contractual.

### Window semantics

| Key | Meaning | Typical horizon |
|---|---|---|
| `rolling` | shortest moving window ("5h" in third-party UIs) | hours |
| `weekly` | weekly quota | days |
| `monthly` | monthly quota | weeks |

### Field semantics

| Field | Type | Notes |
|---|---|---|
| `status` | `"ok"` \| `"rate-limited"` | `rate-limited` means the window is exhausted regardless of `percent` |
| `percent` | number 0–100 | percent **used**, not remaining |
| `resetsAt` | ISO-8601 string | window reset instant (UTC) |

### Parsing rules (validated across two independent implementations + live call)

A window is valid only when **all** hold: `status ∈ {ok, rate-limited}`, `percent` is a
finite number in `[0, 100]`, `resetsAt` is a non-empty string with a finite `Date.parse`.
Invalid windows are dropped, not fatal (fail-open).

```
percentUsed  = status === "rate-limited" ? 1 : percent / 100
limitReached = status === "rate-limited" || percent === 100
```

The binding window is the one with the highest `percentUsed`; its `resetsAt` is the
most relevant countdown.

### Error behavior

| Condition | Meaning | Handling |
|---|---|---|
| `401` / `403` | invalid or revoked key | surface `key-invalid`; do not cache; drop any cached quota for that key |
| `404` | endpoint retired/moved | surface as configuration error naming `usageUrl` |
| network/timeout | unreachable | keep last good snapshot, mark stale |
| malformed JSON | shape drift | `parse` error; last good snapshot stays visible |

## Evidence

- Live call, 2026-10-10: `HTTP 200`, body as above; `/zen/go/v1/quota` → `HTTP 404`.
- [cc-switch issue #6433](https://github.com/farion1231/cc-switch/issues/6433) — documents the
  endpoint, a working extraction script, and the `/v1/usage` vs dashboard-scraping trade-off.
- [OmniRoute commit a2c5d8a](https://github.com/diegosouzapw/OmniRoute/commit/a2c5d8a2f56edc592d442d7a97db2bed76f06373)
  — `opencodeQuotaFetcher.ts`; source of the validator, `percentUsed`/`limitReached`
  semantics, and the note that the URL previously pointed at `/v1/quota` which "returns 404 today".
- Not present in <https://opencode.ai/v2/llms.txt> — official but undocumented, so treat the
  endpoint URL as configurable.

## Implications for `dsh-opencode-go-usage`

- No DeepSeek `/user/balance` involvement: this account reports **subscription quota windows**,
  not currency balance.
- The plugin's server half does one authenticated `GET` per refresh; the key comes from the
  DSH credential seam (`credentialRef("OPENCODE_GO_API_KEY")`), so it is never stored in config
  and never reaches the browser.
- `usageUrl` stays configurable because the API is undocumented and may move.
