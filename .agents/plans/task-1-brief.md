# Task 1 brief — package scaffold and dual-half build pipeline

## Context

Greenfield project at `/home/bruno/dev/projects/dsh-opencode-go-usage` (**not a git repo** — do not run
git commands). We are building `dsh-opencode-go-usage`, an out-of-tree **DeepSeek Harness (DSH) web
plugin** that shows OpenCode Go subscription quota usage in the `dsh web` GUI.

Read these first (they are short):
- `PLAN.md` — the design (sections 3–5 matter most).
- `docs/opencode-go-usage-api.md` — the verified upstream API contract.

Working reference: a real, installed out-of-tree DSH plugin — mirror its packaging conventions:
`/home/bruno/.dsh/profiles/web/node_modules/dsh-lan-guard/` (`package.json`, `lib/index.d.ts`,
`lib/client.js`).

Installed DSH runtime type declarations (read them when a signature matters):
`/home/bruno/.nvm/versions/node/v24.14.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
Relevant installed versions: `@deepseek-ai/cordis` 4.0.4, `@deepseek-ai/schemastery` 3.18.4,
`@deepseek-ai/dsh-*` 0.2.0-rc.2, `@deepseek-ai/dsh-client-ui-slots` 0.2.0-rc.2,
`@deepseek-ai/dsh-host-webserver` 0.2.0-rc.2, `@deepseek-ai/dsh-client-connection` 0.2.0-rc.2,
`@deepseek-ai/dsh-credentials` 0.2.0-rc.2.

## Goal of this task

Scaffold the package and a two-entry build that emits exactly the four artifacts DSH requires.
Entry bodies are **stubs**; Tasks 2 and 3 fill in host and client behavior. Getting the build and the
browser-bundle wrapper right is the whole point of this task.

## Required deliverables

### 1. `package.json`
- `name`: `dsh-opencode-go-usage`, `version`: `0.1.0`, `type`: `module`, MIT, `engines.node >= 20`,
  `packageManager: pnpm@12.10.1`, keywords for DSH plugins.
- `exports`: `"."` → types `./lib/index.d.ts`, default `./lib/index.js`; `"./client"` →
  `./lib/client.js`; `"./package.json"`.
- `files`: `lib/index.js`, `lib/index.d.ts`, `lib/client.js`, `lib/client.js.map`,
  `cordis.patch.yml`, `README.md`, `LICENSE`.
- `scripts`: `build` (tsdown + the client wrapper step), `typecheck` (`tsc --noEmit`),
  `test` (`vitest run --passWithNoTests`), `verify` (`pnpm run typecheck && pnpm run test && pnpm run build`),
  `clean`, `prepack` (`pnpm run build`).
- `dsh` manifest (mirror lan-guard exactly in shape):
  ```json
  "dsh": {
    "manifestVersion": 1,
    "engines": { "dsh": ">=0.1.7-rc.1 <0.3.0" },
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ]
    },
    "compatibility": { "dshReleases": { "0.2.0-rc.2": "compatible" } }
  }
  ```
- `peerDependencies`: `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-host-webserver`,
  `@deepseek-ai/dsh-client-connection`, `@deepseek-ai/dsh-credentials` — use the installed versions
  above (lan-guard uses `>=0.1.7-rc.1 <0.3.0` ranges for dsh packages; either exact `0.2.0-rc.2` or
  that range is acceptable, but the package must install cleanly).
- `devDependencies`: `typescript`, `tsdown`, `vitest`, `@types/node`, `react`, `react-dom`,
  `@types/react`, `@types/react-dom`, plus the peer packages so `tsc --noEmit` resolves their types.
  A known-good reference set: `tsdown ^0.22.14`, `vitest ^4.1.11`, `typescript ^7.0.2`,
  `@types/node ^26.2.0`, `@types/react ^18.3.31`, `react ^18.3.1`. If a version does not resolve,
  pick the nearest published version that installs and record the choice in the report.

### 2. `tsconfig.json`
Strict, ESM/`NodeNext` module resolution, `jsx: "react-jsx"`, `noEmit: true`, `skipLibCheck: true`,
`types: ["node"]`, include `src`. It must typecheck both halves.

### 3. `tsdown.config.ts` — two entries
- **Host half**: `src/index.ts` → `lib/index.js` with `.d.ts` and sourcemap; platform `node`,
  format ESM; externalize `@deepseek-ai/*` and node builtins.
- **Client half**: `src/client/index.tsx` → a raw CJS intermediate (e.g. `lib/client.cjs`),
  platform `browser`, format CJS, **no code splitting / no dynamic chunks**, externalizing
  `react` and `react/jsx-runtime`, with a sourcemap.
Then `scripts/wrap-client.mjs` converts the intermediate into the final `lib/client.js` and removes
the intermediate.

If tsdown cannot express the CJS intermediate exactly, replace this step with an equivalent
rolldown/esbuild/tsc-based build script — the requirement is the artifacts and the exact wrapper
below, not the tool choice.

### 4. `scripts/wrap-client.mjs` — the browser-bundle wrapper (exact format required)

DSH's browser module system loads plugin bundles through a page-global registration facade. The built
`lib/client.js` must have this shape (verified against the installed `dsh-lan-guard` and DSH UI
packages):

```js
window.__ModuleLoader__.load({
	id: "dsh-opencode-go-usage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		<compiled CJS body>
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
```

The wrapper script must: read the package name from `package.json` (do not hardcode a second copy),
assert the compiled body contains an `apply` export and does not already contain
`__ModuleLoader__`, write `lib/client.js`, copy the intermediate's map to `lib/client.js.map`
(adjusting `file` if trivial; an exact line-offset map is not required), and delete the intermediate.
Fail loudly (non-zero exit) on any assertion failure.

### 5. `cordis.patch.yml`
The bundle patch layer, mirroring lan-guard's file, with a comment header:
```yaml
- insert:
    - id: dsh-opencode-go-usage
      name: dsh-opencode-go-usage
```

### 6. `.gitignore`
`node_modules/`, `lib/`, `*.log`, `.DS_Store`, `coverage/`.

### 7. `LICENSE`
MIT license text, `Copyright (c) 2026`.

### 8. `src/wire-types.ts`
Shared, node-safe wire types used by both halves:
- `QuotaWindowStatus = 'ok' | 'rate-limited'`
- `QuotaWindow { id: string; label: string; status: QuotaWindowStatus; percentUsed: number; resetsAt: string; limitReached: boolean }`
- `QuotaSnapshot { label: string; fetchedAt: string; stale: boolean; limitReached: boolean; binding: string | null; windows: QuotaWindow[] }`
- `UsageFailureReason = 'key-missing' | 'key-invalid' | 'not-found' | 'network' | 'parse' | 'http'`
- `UsageEnvelope = { ok: true; snapshot: QuotaSnapshot } | { ok: false; reason: UsageFailureReason; status?: number; message?: string }`

### 9. `src/index.ts` — host plugin stub
Export shape must match lan-guard: `export { Config, apply, inject, name }`.
- `export const name = 'dsh-opencode-go-usage'`
- `export const inject = ['webServer', 'credentials', 'connection']` — **verify these service names**
  against the installed type declarations (`dsh-host-webserver`, `dsh-credentials`,
  `dsh-client-connection`); adjust if a service is named differently, and record what you found.
- `export const Config = Schema.object({ ... })` (schemastery) with exactly:
  `apiKeyEnv: string default 'OPENCODE_GO_API_KEY'`,
  `usageUrl: string default 'https://opencode.ai/zen/go/v1/usage'`,
  `displayName: string default 'OpenCode Go'`,
  `refreshSeconds: number default 60`,
  `timeoutMs: number default 10000`.
  Add short doc comments per field (they become the settings form labels/help).
- `export async function apply(ctx: Context, rawConfig: unknown): Promise<void>` — stub that does
  nothing yet (Task 2 adds route registration). It must typecheck and not throw.

### 10. `src/client/index.tsx` — client plugin stub
- `export const inject = ['slots']`
- `export function apply(ctx: Context): void` — stub, no registration yet (Task 3 adds it).
It must compile to the wrapped bundle format above and require nothing beyond `react` /
`react/jsx-runtime` (both are platform-baseline modules).

## Verified entry contracts (do not deviate)

- Host plugin: `apply(ctx, rawConfig)` async; exports `Config`, `inject`, `name`, `apply`.
- Client plugin: exports `inject: string[]` and `apply(ctx)`.
- Client bundle: `window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => { ... return module.exports } })`.
  Only `react` / `react/jsx-runtime` may be required; this means **no** `dsh.client.external` entry.
- Never register an HTTP route under `/api` (reserved by DSH's connection bridge).
- The `dsh.client.inject` package list must contain every DSH UI package whose slot/service the
  client code needs; Task 3 will register into a slot declared by `@deepseek-ai/dsh-client-ui-sidebar`.

## Conventions

- TypeScript strict, ESM, `import type` for type-only imports, no unjustified `any`.
- Never log, embed, or transmit credential values.
- Do not hand-edit generated output; `lib/**` is build output.

## Verification (run these; record exact commands and results in the report)

```bash
pnpm install
pnpm run build
pnpm run typecheck
test -f lib/index.js && test -f lib/index.d.ts && test -f lib/client.js && test -f lib/client.js.map && echo ARTIFACTS_OK
head -c 40 lib/client.js            # must start with: window.__ModuleLoader__.load(
grep -c 'dsh-opencode-go-usage' lib/client.js   # must be >= 1
ls lib/                              # intermediate raw client file must be gone
```

## Writable scope (only these paths)

`package.json`, `tsconfig.json`, `tsdown.config.ts`, `scripts/wrap-client.mjs`, `cordis.patch.yml`,
`.gitignore`, `LICENSE`, `src/wire-types.ts`, `src/index.ts`, `src/client/index.tsx` (all created).

Allowed generated side effects (excluded from review): `lib/**`, `pnpm-lock.yaml`, `node_modules/**`.

Report path (also allowed): `.agents/plans/task-1-report.md`.

If you need any other path, stop and reply exactly
`BLOCKED: SCOPE_EXPANSION: <path> — <reason>` instead of editing it.

## Report (final step — mandatory)

Write `.agents/plans/task-1-report.md` containing: status, changed paths, key decisions (especially
how the client wrapper is produced and which service names you verified), the exact verification
commands with their observed results, and any blocker or not-applicable check.
