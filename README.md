# dsh-opencode-go-usage

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **Web** plugin
that puts your **OpenCode Go** subscription quota in the sidebar.

It adds one compact indicator to the sidebar foot (beside Settings). The indicator
itself carries **all three quota windows** — rolling / weekly / monthly — as
`label percent` pairs, so a drained short window is visible without opening
anything. Click it for a popover with a row per window, the percent used, and a
live countdown to each reset.

```
5h 1%   wk 19%   mo 30%        ← sidebar foot indicator (all three windows)
 ├ rolling   1% used   resets in 13h
 ├ weekly   19% used   resets in 2d
 └ monthly  30% used   resets in 13d
   updated 4m ago
```

In the collapsed 56px rail there is room for one number only, so the rail shows
the **binding** window (the one with the highest usage) beside the status dot.

The reading comes from the API key the harness **already uses** for the
`opencode-go` provider route — there is nothing new to configure if that key is
already in the DSH credential store.

## What it shows

| Window | Meaning | Typical horizon |
|---|---|---|
| `rolling` | shortest moving window (labelled `5h`) | hours |
| `weekly` | weekly quota | days |
| `monthly` | monthly quota | weeks |

Each window carries a **percent used** (0–100 %) and a **reset instant**. The
indicator shows all three windows at once, shortening the labels to `5h` / `wk` /
`mo`; each percentage takes its window's colour as that window approaches 100 %,
and the status dot grades the *binding* window — the one with the highest usage.

### There are no dollar amounts

The upstream endpoint returns **percentages only** — `status`, `percent`, and
`resetsAt` per window. It carries no currency or token totals, and this plugin
does not estimate them. The verified contract and its evidence, including why
`/zen/go/v1/quota` (404) is not used, are recorded in
[docs/opencode-go-usage-api.md](docs/opencode-go-usage-api.md); the evidence that
`/zen/v1/usage` returns HTML rather than JSON is in [PLAN.md](PLAN.md) §3.

## Requirements

| Requirement | Version | Notes |
|---|---|---|
| DSH | `>=0.1.7-rc.1 <0.3.0` | Declared in `package.json` → `dsh.engines.dsh`; verified against the installed `0.2.0-rc.2` (`dsh --version`) |
| Node.js | `>=20` | Declared in `package.json` → `engines.node` |
| A Web profile | `web` | The plugin's browser half targets `platform: "web"` only |
| An `opencode-go` credential | — | A reference in the DSH credential store, by default `OPENCODE_GO_API_KEY` |

## Quickstart

```bash
# 1. Build — lib/ is generated, not committed
pnpm install
pnpm run build

# 2. Install into the Web profile (see docs/install.md for the GUI path)
dsh plugin --profile web add /absolute/path/to/dsh-opencode-go-usage

# 3. Verify
dsh --profile web --dump-config      # the dsh-opencode-go-usage row is composed
curl -i http://127.0.0.1:3080/__dsh_opencode_go_usage__/usage   # 401/403 without a session
```

Then reload the Web GUI: the indicator appears at the sidebar foot.

Full install mechanics, including a manual fallback and uninstall, are in
[docs/install.md](docs/install.md). Tests and the live checklist are in
[docs/testing.md](docs/testing.md).

> `pnpm run build` must have been run before installing: DSH resolves the host half
> from `lib/index.js` and the browser half from `lib/client.js`. Those files are
> build output and are not part of the source tree.

**Unverified in this document's environment:** the expected output of
`dsh --profile web --dump-config` and of `dsh plugin --profile web --help`. Both
commands need write access to `$DSH_HOME` and were denied here; the verbs themselves
are verified from the launcher's own `dsh --help`. The
[environment-limits table](docs/install.md#environment-limits-while-writing-this-document)
in docs/install.md records each attempt and its exact error.

## Configuration

The plugin's exported `Config` schema *is* the DSH settings form for the
`dsh-opencode-go-usage` entry. **Every field has a working default**, so a fresh
install needs no configuration at all; add a `config:` block under the plugin row
only to override something.

| Field | Default | Effect |
|---|---|---|
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | Name of the credential **reference** resolved through the DSH credential seam. This is the name of the secret, never its value — nothing secret is ever stored in configuration. |
| `usageUrl` | `https://opencode.ai/zen/go/v1/usage` | Quota endpoint. The upstream API is official but undocumented, so the URL stays configurable in case it moves. |
| `displayName` | `OpenCode Go` | Label shown on the widget and in the popover header. |
| `refreshSeconds` | `60` | How long a fetched snapshot is served before another provider request is made (the server-side TTL). The browser never calls the provider itself: the widget re-reads this plugin's own route about once a minute, and the TTL decides whether that read reaches the provider. |
| `timeoutMs` | `10000` | Deadline for a single provider request, in milliseconds (enforced with an `AbortSignal`). |

Example override in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-opencode-go-usage
  name: dsh-opencode-go-usage
  config:
    displayName: Go quota
    refreshSeconds: 300
```

Credential values are never accepted here. `apiKeyEnv` must be a valid credential
reference name (a POSIX shell identifier); anything else is reported as
`key-missing` without being echoed back.

## How it works

```
browser (sidebar widget)                 host (Cordis plugin)              upstream
────────────────────────                 ────────────────────              ────────
GET  /__dsh_opencode_go_usage__/usage ──▶ admit(request)  ── rejection ▶ 401/403
POST /__dsh_opencode_go_usage__/refresh  │  cache fresh? ── yes ──▶ serve cached snapshot
                                         │  else resolve credential ref
                                         │       │
                                         │       └──▶ GET $usageUrl  ────▶  Authorization: Bearer <key>
                                         │            parse + validate ◀────  { usage: { rolling, weekly, monthly } }
                                         └── cache success only
```

- **The key is resolved host-side, per fetch**, through the DSH credential seam
  (`ctx.credentials.resolve(credentialRef(apiKeyEnv))`). A rotated key applies to
  the next fetch with no restart and no configuration edit.
- **The key never reaches the browser.** Only the quota envelope — label, window
  percentages, reset instants, timestamps, error *reasons* — crosses into the
  client. Responses are `no-store`, carry no credential, and never echo the raw
  upstream body.
- **Both routes are authenticated.** The handler calls `ctx.connection.admit()`
  first and passes a refusal status through verbatim; an unauthenticated request
  never reaches the provider or the cache.
- **Both routes are exact paths** under `/__dsh_opencode_go_usage__/`, deliberately
  not under `/api` (which the connection bridge owns). A collision is a loud load
  failure, not a silent hijack.
- **Nothing is written outside the process.** There is no local database and no
  session-log scraping; the cache is in-memory with a single-flight guard so a
  burst of browser polls produces at most one provider request.

## Documentation

| Document | Contents |
|---|---|
| [docs/install.md](docs/install.md) | Installing, key configuration, verification, uninstalling |
| [docs/testing.md](docs/testing.md) | Unit suites, full gates, build assertions, live checklist, troubleshooting |
| [docs/opencode-go-usage-api.md](docs/opencode-go-usage-api.md) | Verified upstream API contract, parsing rules, error behaviour, evidence |
| [PLAN.md](PLAN.md) | Design decisions, architecture facts, risks, and the manual live checklist |

## License

[MIT](LICENSE)
