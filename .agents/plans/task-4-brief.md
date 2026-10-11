# Task 4 brief — install/test documentation + final hardening

## Context

Project root: `/home/bruno/dev/projects/dsh-opencode-go-usage` (**not a git repo** — no git commands).
Tasks 1–3 are complete and passed review. The plugin is fully implemented:
- host half: `GET /__dsh_opencode_go_usage__/usage` and `POST /__dsh_opencode_go_usage__/refresh`
  behind `ctx.connection.admit()`, credential resolved via `credentialRef(config.apiKeyEnv)`;
- client half: `UsageIndicator` registered into the `sidebar.footer.action` slot;
- 4 real test files; `pnpm run build` emits `lib/index.js`, `lib/index.d.ts`, `lib/client.js`,
  `lib/client.js.map`.

Read first: `PLAN.md` (design + §6.4 manual checklist), `docs/opencode-go-usage-api.md` (verified
upstream contract), `src/route.ts` (route constants and response shapes), `package.json` (scripts).
For install mechanics read the shipped CLI README:
`/home/bruno/.nvm/versions/node/v24.14.0/lib/node_modules/@deepseek-ai/dsh/README.md` (sections
"Entry modes", "Profiles", "Optional overlays") and the plugin-manager README at
`.../node_modules/@deepseek-ai/dsh-plugin-manager/README.md` (install/bundle-selection semantics).

## Goal of this task

Make the plugin installable and testable by someone who has never seen it, and close three small
gaps found during task reviews. **Do not install the plugin into any live profile** — document it.

## Deliverables

### 1. Test-scope fix (mandatory)
`pnpm exec vitest run` currently also picks up stale copies under
`.agents/plans/snapshots/**` (orchestrator workflow artifacts), so the suite reports 5 files instead
of 4. Add a `vitest.config.ts` (or a `vitest` field in `package.json`) that excludes `.agents/**`
from test discovery. Requirement: `pnpm exec vitest run` reports **exactly these 4 files**:
`src/cache.test.ts`, `src/quota-parse.test.ts`, `src/route.test.ts`, `src/client/usage-view.test.ts`.

### 2. Admission-throw regression test (mandatory, from the Task 3 review)
Add a case to `src/route.test.ts` where the injected `admit` **throws** an `Error` whose message
contains a fake credential-looking token (e.g. `sk-FAKE-SECRET-VALUE`). Assert the handler responds
`500` with the module's fixed body (`{"ok":false,"reason":"http","status":500,"message":"internal error"}`
— confirm the exact shape from `src/route.ts`) and that neither the thrown message nor the fake token
appears anywhere in the response body or headers.

### 3. Stronger route-path drift guard (mandatory, from the Task 3 review)
In `src/client/usage-view.test.ts`, import `USAGE_ROUTE` and `REFRESH_ROUTE` from `../route.js`
(node-side test import only) and assert the client-local path constants equal those host exports, so
a host-side rename fails the test. After `pnpm run build`, confirm the test-only import did **not**
leak into the browser bundle: `lib/client.js` must contain no `@deepseek-ai/` require and only
`require("react")` / `require("react/jsx-runtime")`.

### 4. `README.md`
- What it is and what it shows: the OpenCode Go subscription quota (rolling/weekly/monthly percent
  used + reset times) for the API key the harness already uses, as a sidebar widget.
- Requirements: DSH `>=0.1.7-rc.1 <0.3.0` (verified against `0.2.0-rc.2`), Node `>=20`.
- Quickstart: build, install (link `docs/install.md`), verify.
- Configuration table: the five fields (`apiKeyEnv`, `usageUrl`, `displayName`, `refreshSeconds`,
  `timeoutMs`) with defaults and effect.
- How it works (short): host-side fetch with the key resolved from the credential store; the key
  never reaches the browser; the browser only reads the plugin's own authenticated route.
- Explicit note: **no dollar amounts** — the upstream endpoint returns percentages only, with a link
  to `docs/opencode-go-usage-api.md`.
- Links to `docs/install.md`, `docs/testing.md`, `docs/opencode-go-usage-api.md`, `PLAN.md`.

### 5. `docs/install.md`
- **Path A (recommended):** install from the Web GUI's Plugins page (the plugin manager selects the
  bundle automatically).
- **Path B (CLI):** the profile-forwarding command. **Verify the real verb** by running
  `dsh plugin --help` (read-only) and/or reading the CLI README; document exactly what works. If you
  cannot verify a detail, mark it explicitly as unverified rather than inventing it.
- **Manual fallback:** add the dependency to the profile and ensure the bundle row is selected, with
  the exact YAML from this package's `cordis.patch.yml` and the profile file paths
  (`$DSH_HOME/profiles/web/package.json`, `cordis.patch.yml`).
- **Key configuration:** how the credential reference resolves (`$DSH_HOME/.credentials.yaml`
  `refs`/env), and how to confirm presence without printing the secret.
- **Verification:** `dsh --profile web --dump-config` shows the plugin row; the widget appears at the
  sidebar foot; an unauthenticated `curl` of the route returns 401/403.
- **Uninstall:** deselect the bundle, then remove the dependency.
- **Warning:** installing into a *running* profile can hot-reload the GUI; restart if unsure. State
  that this document was not executed against a live profile.

### 6. `docs/testing.md`
- Unit suites and focused commands; the full gates (`pnpm run test`, `pnpm run typecheck`,
  `pnpm run build`) and the four-artifact + wrapper assertions.
- The manual live checklist from `PLAN.md` §6.4, with a `curl` example for the upstream endpoint that
  uses a placeholder (`$OPENCODE_GO_API_KEY`) and never prints a real key.
- Troubleshooting table: widget missing (bundle not selected; `lib/client.js` missing → build),
  route 401 (session cookie), `key-missing`, `key-invalid`, `not-found` (`usageUrl`), `parse`
  (upstream shape changed), stale marker (endpoint unreachable).
- Every command you document must exist in `package.json` (or be an external command you name
  explicitly) and must actually pass.

### 7. Documentation consistency check (mandatory)
Verify mechanically that each npm script referenced in `README.md`, `docs/install.md` and
`docs/testing.md` exists in `package.json`, and that every relative markdown link target exists on
disk. Record the exact check command and its output in the report.

## Conventions

- Documentation is factual: no invented CLI flags, no claims you did not verify. Mark unverified
  items explicitly.
- Never print, log, or document a real credential value; use placeholders.
- Keep code changes minimal and confined to the declared scope.

## Verification (run these; record exact commands and observed results)

```bash
pnpm exec vitest run                     # exactly 4 files, all passing
pnpm run test
pnpm run typecheck
pnpm run build
test -f lib/client.js && head -c 40 lib/client.js
grep -c '@deepseek-ai/' lib/client.js    # must be 0
dsh plugin --help                        # read-only; use it to verify documented install verbs
```

## Writable scope (only these paths)

Created: `README.md`, `docs/install.md`, `docs/testing.md`, `vitest.config.ts` (only if you choose a
config file over the `package.json` field).
Modified: `package.json`, `src/route.test.ts`, `src/client/usage-view.test.ts`.

Allowed generated side effects (excluded from review): `lib/**`, `pnpm-lock.yaml`, `node_modules/**`.
Report path (also allowed): `.agents/plans/task-4-report.md`.

Do **not** modify `PLAN.md`, `docs/opencode-go-usage-api.md`, the `src/` implementation files, or
anything under `.agents/plans/snapshots/`. If you need another path, stop and reply exactly
`BLOCKED: SCOPE_EXPANSION: <path> — <reason>` instead of editing it.

## Report (final step — mandatory)

Write `.agents/plans/task-4-report.md`: status, changed paths, the three hardening fixes, which
install details you verified versus marked unverified, the documentation consistency check command
and output, exact verification commands with observed results, and any blocker.
