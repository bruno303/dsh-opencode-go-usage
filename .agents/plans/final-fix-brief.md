# Final consolidated fix brief — resolve the aggregate-review findings

## Context

Project root: `/home/bruno/dev/projects/dsh-opencode-go-usage` (**not a git repo** — no git commands).
The feature is complete and its task-level gates passed. The final aggregate review returned
`CHANGES_REQUESTED` with four medium findings and one low finding. This is the **single consolidated
fix pass**; there is no further review round after it.

Read first: `PLAN.md` (design + the promises these findings say are unmet), `docs/testing.md`,
`README.md`, and the implementation under `src/`.

Do not modify `PLAN.md` or `docs/opencode-go-usage-api.md`. Prefer **implementing** what the design
and docs promise over weakening those claims (except where noted in F5).

## Findings to resolve

### F1 (medium) — the widget's relative time is frozen; no scheduled refresh
`src/client/UsageIndicator.tsx` fetches once on mount and memoizes the view on `[envelope, now]`
where `now` is `undefined` in production, so the reset countdown and "updated …" text never change.
`README.md` promises a "live countdown to each reset", and the host's `refreshSeconds` TTL is inert
because nothing re-reads on a schedule.

Required:
- Recompute relative text as time passes: drive a ticking clock (e.g. a 1 s or 30 s interval state)
  and compute the view at render time so countdown/elapsed text actually advances.
- Add a bounded periodic `GET` so the widget stays current (a default ~60 s poll is fine; the host's
  TTL dedupes upstream calls). Keep the manual Refresh button.
- Clear every timer on unmount. Do not update state after unmount.
- Keep `usage-view.ts` pure; the component owns timers.

### F2 (medium) — the compile-time slot-contract drift guard is not implemented
`@deepseek-ai/dsh-client-ui-sidebar` and `@deepseek-ai/dsh-client-ui-slots` are missing from
`devDependencies`, so the client's slot usage is typed only by local structural interfaces and a
future DSH slot-contract change cannot fail `typecheck`. `PLAN.md` §4 and `docs/testing.md` both
claim this guard exists.

Required:
- Add both packages as `devDependencies` at the versions the installed runtime uses
  (`0.2.0-rc.2`; verify by reading their `package.json` under
  `/home/bruno/.nvm/versions/node/v24.14.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`).
- Type the client registration against the **real** declarations (type-only imports are erased and
  must not enter the browser bundle): use the installed `SlotMap`/registry types for
  `'sidebar.footer.action'` and the `register` options so a contract change breaks `typecheck`.
  Replace the local structural stand-ins where the real types apply; keep the file compiling.
- Re-verify after the change that `lib/client.js` still contains **no** `@deepseek-ai/` require.

### F3 (medium) — the React component has no test
`PLAN.md` §5 requires `src/client/UsageIndicator.test.tsx`; only the pure helpers are covered, leaving
the transport lifecycle untested.

Required:
- Add `src/client/UsageIndicator.test.tsx` covering: initial load → ok render; stale marker;
  each error reason's copy; the `POST` refresh path and its in-flight disable; and that a response
  resolving **after unmount** neither updates state nor warns (no state write after unmount).
- Add `jsdom` and `@testing-library/react` as `devDependencies` (the in-repo DSH client packages use
  `@testing-library/react`; pick published versions that install). Enable the DOM per file with a
  `// @vitest-environment jsdom` docblock rather than changing the global test environment.
- Inject the fetch seam and the clock; no real network, no real timers left running (use fake timers
  where a tick is involved and restore them).

### F4 (medium) — the real credential-resolution path is untested
Every route test injects a fake `loadEnvelope`, so `src/index.ts`'s credential-reference guard,
`ctx.credentials.resolve(...) === undefined → key-missing`, the `fetchQuota` call, and the
`ctx.effect` route registration/disposal are never exercised.

Required:
- Refactor minimally so the real `loadEnvelope` logic is unit-testable without a live Cordis runtime
  (for example export a small factory from `src/index.ts` that takes injected
  `{ resolveCredential, fetchImpl, config, now }` and returns the loader; `apply()` then wires the
  real dependencies to it). Keep the exported plugin shape (`Config`, `apply`, `inject`, `name`)
  exactly as it is.
- Add tests (a new `src/index.test.ts` is fine) asserting: an absent credential yields a
  `key-missing` envelope **and** performs no fetch; a present credential calls the fetch with the
  configured URL/timeout; and the returned envelope never contains the credential value.
- If practical without a live runtime, also cover route registration + disposal with a fake
  `webServer`/`ctx.effect`; if not practical, say so explicitly in the report instead of inventing a
  brittle harness.

### F5 (low) — `X-Usage-Snapshot-Age-Ms` is produced but never consumed
`src/route.ts` sets the header and tests assert it, but no client code reads it, so its stated
purpose (avoiding server/browser clock skew in the "updated … ago" text) is unrealized.

Required: **consume it.** Have the client fetch read the header and use the server-reported age for
the "updated … ago" text (fall back to computing from `fetchedAt` when the header is absent), so the
clock-skew case is actually handled. Update `usage-view.ts` (and its tests) accordingly. If you
conclude consuming it is genuinely wrong, remove the header, its comment, and its test instead — but
consuming it is preferred.

### F6 (docs consistency — follow-on from F1–F5)
- Update `docs/testing.md` so its test inventory, environment notes, and any file counts match
  reality after these changes (the component and index tests now exist; jsdom is per-file).
- Update `README.md` only if a statement is still inaccurate after F1–F5.

## Constraints

- Do not weaken or delete existing passing tests to make things fit; extend them.
- Never print, log, embed, or return the credential value; keep every error message secret-free.
- The browser bundle must keep requiring only `react` / `react/jsx-runtime` and keep the
  `window.__ModuleLoader__.load({ id: "dsh-opencode-go-usage", factory: (require) => { … } })` shape.
- Do not touch `review-*.diff` artifacts, `PLAN.md`, `docs/opencode-go-usage-api.md`, or anything
  under `.agents/plans/snapshots/`.
- Generated side effects allowed: `lib/**`, `pnpm-lock.yaml`, `node_modules/**`.

## Verification (run these; record exact commands and observed results)

```bash
pnpm install
pnpm exec vitest run                 # all suites pass; list every file it reports
pnpm run typecheck                   # must now cover the real slot types
pnpm run build
test -f lib/client.js && head -c 40 lib/client.js
grep -c '@deepseek-ai/' lib/client.js   # must be 0
pnpm run verify
```

## Writable scope (only these paths)

Modified: `src/client/UsageIndicator.tsx`, `src/client/usage-view.ts`, `src/client/usage-view.test.ts`,
`src/index.ts`, `src/route.test.ts`, `package.json`, `docs/testing.md`, `README.md`.
Created: `src/client/UsageIndicator.test.tsx`, `src/index.test.ts`.
Also allowed: `src/client/index.tsx` (only if F2's real typing requires touching the registration
call), and `.agents/plans/final-fix-report.md`.

If you need another path, stop and reply exactly
`BLOCKED: SCOPE_EXPANSION: <path> — <reason>` instead of editing it.

## Report (final step — mandatory)

Write `.agents/plans/final-fix-report.md`: status, changed paths, per-finding resolution (F1–F6) with
the concrete change and the test that now covers it, the exact verification commands with observed
results, and anything you could not resolve or chose to handle differently with the reason.
