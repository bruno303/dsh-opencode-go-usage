# Task 1 report — package scaffold and dual-half build pipeline

**Status: DONE.** All required deliverables exist, `pnpm run verify` passes, and every artifact DSH
requires is produced with the exact wrapper format. Two environment/spec caveats are recorded in
§5–§6 (neither blocks the task).

## 1. Changed paths (all created; no pre-existing file modified)

| Path | Purpose |
|---|---|
| `package.json` | Manifest: `dsh` bundle manifest, `exports`, `files`, scripts, peers, devDeps |
| `tsconfig.json` | Strict `NodeNext` ESM config covering both halves (`jsx: react-jsx`) |
| `tsdown.config.ts` | Two-entry build (host ESM + client CJS intermediate) |
| `scripts/wrap-client.mjs` | Browser-bundle facade wrapper + source-map offsetting |
| `cordis.patch.yml` | Bundle patch layer (comment header + `insert` row) |
| `.gitignore` | `node_modules/`, `lib/`, `*.log`, `.DS_Store`, `coverage/` |
| `LICENSE` | MIT, `Copyright (c) 2026` |
| `src/wire-types.ts` | Shared node-safe wire types (types only, no runtime import) |
| `src/index.ts` | Host Cordis plugin stub (`Config`, `apply`, `inject`, `name`) |
| `src/client/index.tsx` | Browser Cordis plugin stub (`apply`, `inject`) |

Generated side effects, not reviewed: `lib/**`, `pnpm-lock.yaml`, `node_modules/**`.

Nothing outside the brief's writable scope was touched. A temporary npm cache directory was created
at the project root early on and removed immediately; the working cache lives under
`node_modules/.npm-cache` (allowed generated path).

## 2. Key decisions

### 2.1 Build pipeline

`tsdown` 0.22.14 (rolldown 1.2.13) with two configs in one exported array:

* **Host** — `src/index.ts` → `lib/index.js`, `lib/index.d.ts`, `lib/index.js.map`. `platform: node`,
  `format: esm`, `dts: true`, `deps.neverBundle: [/^@deepseek-ai\//]` (node builtins stay external by
  default). `clean: true` on this config only.
* **Client** — `src/client/index.tsx` → `lib/client.cjs` + `lib/client.cjs.map`. `platform: browser`,
  `format: cjs`, `target: es2022`, `dts: false`, `deps.neverBundle: ['react', 'react/jsx-runtime']`,
  `outputOptions: { codeSplitting: false }`, `clean: false`.

Two `tsdown` details worth recording, because the naive config does not meet the brief:

1. The package is `"type": "module"`, so tsdown's default extensions are `.mjs` / `.d.mts`. The host
   config therefore sets
   `outExtensions: () => ({ js: '.js', dts: '.d.ts' })` to produce exactly `lib/index.js` and
   `lib/index.d.ts`. The client config pins `{ js: '.cjs' }` for the intermediate.
2. tsdown 0.22.14 has **no** top-level `splitting` option (`UserConfig` rejects it — this failed the
   first typecheck). Code splitting is a rolldown `OutputOptions` field, reachable through tsdown's
   passthrough `outputOptions`, so the client config uses `outputOptions: { codeSplitting: false }`.

`external` is deprecated in this tsdown version (warning: *"use `deps.neverBundle` instead"*), so the
non-deprecated option is used throughout and the build is warning-free.

The two configs share `outDir: 'lib'`. `clean: true` is set only on the host config, and tsdown
cleans before writing any of the batch, so the client half is never wiped. Verified stable across
repeated builds from both a clean and a populated `lib/` (§4.3).

### 2.2 `scripts/wrap-client.mjs`

Reads the plugin id from `package.json` (no second copy of the name anywhere in the script), then:

1. **Validates the intermediate** — non-empty; must not already contain `__ModuleLoader__`; must
   export `apply` (five accepted CJS/ESM lowering shapes); no extra `.cjs` chunks in `lib/`
   (enforces the "one self-contained module" requirement independently of the `codeSplitting` flag).
2. **Normalises the body** — strips the intermediate's own trailing `//# sourceMappingURL=client.cjs.map`
   comment (it points at a file this script deletes) and strips a leading duplicate
   `Object.defineProperty(exports, Symbol.toStringTag, …)` line (the wrapper header already declares
   it for the same `exports` object).
3. **Wraps** in the exact facade format from the brief: `window.__ModuleLoader__.load({ id, factory })`,
   body inserted verbatim at column 0 on its own line, then `//# sourceMappingURL=client.js.map`.
4. **Writes the map** — `file: 'client.js'` plus `';'.repeat(lineOffset)` prepended to `mappings`.
   The offset is `headerLines - bodyLinesRemoved`, so the map stays **exact**, not merely approximate:
   decoding `lib/client.js.map` maps generated L17 → `src/client/index.tsx` L13 and generated L27 →
   L24, which are the correct anchors (§4.4).
5. **Deletes** `lib/client.cjs` and `lib/client.cjs.map`, and validates the assembled bundle parses
   (`new vm.Script`, parse-only, so no `window`/`react` is needed).

Every assertion exits non-zero; all six failure paths were exercised and confirmed (§4.5).

**Note on the source map.** An earlier revision stripped the duplicate `Symbol.toStringTag` line
without decrementing the offset, which shifted every mapping by one line. It was caught by decoding
the emitted map and is fixed; the map is now verified line-exact.

### 2.3 Service names verified (brief §9 asked for this explicitly)

`export const inject = ['webServer', 'credentials', 'connection']` is **correct as written**. Each is
declared on the Cordis `Context` interface by the installed `0.2.0-rc.2` runtime:

| Service | Declaring package | Location | Declaration |
|---|---|---|---|
| `webServer` | `@deepseek-ai/dsh-host-webserver` | `lib/types/index.d.ts:17` | `webServer: WebServer;` |
| `credentials` | `@deepseek-ai/dsh-credentials` | `lib/types/index.d.ts:100` | `credentials: CredentialProvider;` |
| `connection` | `@deepseek-ai/dsh-client-connection` | `lib/types/rpc-host.d.ts:9` | `connection: HostConnectionHandle;` |

No adjustment was needed. The client half's `inject = ['slots']` matches the reference plugin's
built browser bundle (`dsh-lan-guard/lib/client.js`: `inject: ["slots"]`); the owning DSH package is
`@deepseek-ai/dsh-client-ui-slots` (see §6.2 for a Task 3 consequence).

### 2.4 Version choices

`pnpm install` resolves to exactly the intended set — `tsdown@0.22.14`, `vitest@4.1.11`,
`typescript@7.0.2`, `@types/node@26.6.5` (`^26.2.0`), `@types/react@18.3.31`, `react@18.3.1`,
`react-dom@18.3.1`, and the pinned `@deepseek-ai/*` peers at their installed versions.

**One deliberate deviation:** the brief suggests `@types/react-dom ^18.3.31`, but the newest published
18.x is **18.3.7** (`^18.3.31` does not exist; the package jumped 18.3.7 → 19.x). The nearest
published version that installs, `^18.3.7`, is used instead. This is a version-metadata typo in the
brief, not a functional gap.

Peer ranges: `@deepseek-ai/cordis ^4.0.4` and `@deepseek-ai/schemastery ^3.18.4` (mirroring
lan-guard); the three `dsh-*` peers use lan-guard's `>=0.1.7-rc.1 <0.3.0`, which the brief permits and
which is satisfied by the pinned `0.2.0-rc.2` devDeps. Install is clean.

## 3. Deliverable-specific notes

* **`src/index.ts`** — `Config` uses `Schema.object` with the five required fields and their exact
  defaults, each carrying a `.description(...)`. `description` is the metadata the settings form
  reads (`dsh-client-ui-settings/lib/client.js:370` reads `schema.meta.description`), so these become
  the real form labels/help; all five survive into the built `Config` (verified at runtime, §4.6).
  `apply` is an async stub that touches neither `ctx` nor `rawConfig` beyond a `void`.
* **`src/client/index.tsx`** — stub `apply(ctx)`; compiles to the wrapped facade bundle and requires
  **nothing** today (the stub has no React import). Externalisation of `react/jsx-runtime` was proven
  separately with a temporary JSX probe (§4.7).
* **`src/wire-types.ts`** — types only, no runtime import; not yet consumed by either half (Tasks 2
  and 3 will import it). It typechecks as part of `include: ["src"]`.
* **`cordis.patch.yml`** — parses to exactly `[{"insert": [{"id": "dsh-opencode-go-usage", "name":
  "dsh-opencode-go-usage"}]}]` (validated with a YAML parser).

## 4. Verification — exact commands and observed results

### 4.1 The brief's verification block

```
$ pnpm install
Already up to date
Done in 2ms using pnpm v12.10.1
exit=0

$ pnpm run build
ℹ  [CJS] lib/client.cjs      0.95 kB │ gzip: 0.59 kB
ℹ  [CJS] lib/client.cjs.map  1.11 kB │ gzip: 0.66 kB
✔  Build complete in 51ms
ℹ  [ESM] lib/index.js      2.75 kB │ gzip: 1.34 kB
ℹ  [ESM] lib/index.js.map  3.71 kB │ gzip: 1.69 kB
ℹ  [ESM] lib/index.d.ts    2.67 kB │ gzip: 1.13 kB
✔  Build complete in 134ms
[wrap-client] wrote lib/client.js (id: dsh-opencode-go-usage, body offset 5 lines) and lib/client.js.map
exit=0

$ pnpm run typecheck
$ tsc --noEmit
exit=0

$ test -f lib/index.js && test -f lib/index.d.ts && test -f lib/client.js && test -f lib/client.js.map && echo ARTIFACTS_OK
ARTIFACTS_OK

$ head -c 40 lib/client.js
window.__ModuleLoader__.load({
	id: "dsh

$ grep -c 'dsh-opencode-go-usage' lib/client.js
2

$ ls lib/
client.js
client.js.map
index.d.ts
index.js
index.js.map
```

`ls lib/` confirms the raw intermediate (`client.cjs`) and its map are gone. `lib/index.js.map` is an
expected extra (the brief requires a host sourcemap; it is intentionally not in `files` — see §5.2).

### 4.2 `pnpm run verify` (typecheck → test → build)

```
$ pnpm run verify
$ tsc --noEmit
$ vitest run --passWithNoTests
No test files found, exiting with code 0
$ tsdown && node scripts/wrap-client.mjs
... (build output as above) ...
exit=0
```

`pnpm run test` on its own: `No test files found, exiting with code 0` (expected — Task 1 ships no
tests; `--passWithNoTests` is the brief's script).

### 4.3 Build determinism

`rm -rf lib && pnpm run build` three times, plus two incremental builds with artifacts already
present: all five runs exited 0 and left exactly `client.js`, `client.js.map`, `index.d.ts`,
`index.js`, `index.js.map`.

### 4.4 Client bundle and source map

`lib/client.js` — first 6 lines are the facade header, the body starts at line 7, and the file ends
with `//# sourceMappingURL=client.js.map` (35 lines total; no duplicate `Symbol.toStringTag`, no stale
`client.cjs.map` reference).

Runtime load through a simulated facade (`vm` context exposing
`window.__ModuleLoader__ = { load: (def) => … }`, factory invoked with `createRequire`):

```
registered id     : "dsh-opencode-go-usage"
factory is func   : true
exported keys     : ["apply","inject"]
apply is function : true
inject            : ["slots"]
toStringTag       : [object Module]
CLIENT_RUNTIME_OK
```

Source-map decode (custom VLQ decoder over `lib/client.js.map`):

```
map.file            : "client.js"
map.sources         : ["../src/client/index.tsx"]
gen L17 -> src L13  "const inject = [\"slots\"];"
gen L27 -> src L24  "function apply(ctx) {}"
code segments checked: 9 | bad pairs: 0
SOURCEMAP_OFFSET_OK
```

### 4.5 Wrapper failure paths (all exit 1, each with a distinct `[wrap-client] ERROR:` line)

```
missing intermediate      -> exit=1
already wrapped           -> exit=1
no apply export           -> exit=1
stray CJS chunk           -> exit=1
missing sourcemap         -> exit=1
empty body                -> exit=1
```

A variant intermediate *without* the duplicate `Symbol.toStringTag` line was also exercised: the
wrapper reported `body offset 6 lines` (correct for that shape), the body landed on line 7, and
`map.file` was `client.js`.

### 4.6 Host bundle

```
exported keys : ["Config","apply","inject","name"]
name          : "dsh-opencode-go-usage"
inject        : ["webServer","credentials","connection"]
apply is async: AsyncFunction
Config values : {"apiKeyEnv":"OPENCODE_GO_API_KEY","usageUrl":"https://opencode.ai/zen/go/v1/usage",
                 "displayName":"OpenCode Go","refreshSeconds":60,"timeoutMs":10000}
HOST_RUNTIME_OK
FORM_METADATA_OK   # all five fields carry a non-empty meta.description
```

### 4.7 React externalisation probe

A temporary `export function Probe() { return <span /> }` was appended to `src/client/index.tsx`,
built, inspected, then reverted (file confirmed byte-identical to its intended content afterwards;
`pnpm run typecheck` clean and `pnpm run build` re-run):

```
$ grep -o 'require("[^"]*")' lib/client.js | sort -u
require("react/jsx-runtime")
```

Only the platform-baseline module is required; React itself is not bundled. After reverting, the stub
bundle contains no `require` calls at all.

### 4.8 Packaging

`pnpm pack --dry-run` exits 0 (its `prepack` runs the build) and lists `cordis.patch.yml`,
`lib/client.js`, `lib/client.js.map`, `lib/index.d.ts`, `lib/index.js`, `LICENSE`, `package.json`.

## 5. Blockers and caveats

### 5.1 `pnpm install` needs `XDG_RUNTIME_DIR` in this sandbox — not a project defect

Plain `pnpm install` in this session fails with:

```
ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK
  Failed to open the store operation lock at "pnpm-store-operation-locks":
  Read-only file system (os error 30)
```

pnpm 12 places its store operation lock under `$XDG_RUNTIME_DIR`, which here is `/run/user/1002` —
outside the session workspace and therefore read-only under the `workspace-write` file policy. The
store and cache already resolve inside the workspace (`node_modules/.pnpm-store`, via
`XDG_CACHE_HOME`), so only the lock is affected. This is the known pnpm behaviour documented in
[pnpm#16390](https://github.com/pnpm/pnpm/issues/16390). The install was performed with:

```bash
XDG_RUNTIME_DIR="$PWD/node_modules/.xdg-runtime" pnpm install
```

which exits 0 and writes a normal `pnpm-lock.yaml`. No project file encodes this workaround; on a
normal machine `pnpm install` works unmodified. Anyone re-running the brief's verification in a
similarly sandboxed shell needs the same prefix.

### 5.2 `files` omits `lib/index.js.map`, which the shipped host bundle references

The brief requires the host build to emit a sourcemap but lists only `lib/index.js`,
`lib/index.d.ts`, `lib/client.js`, `lib/client.js.map`, `cordis.patch.yml`, `README.md`, `LICENSE` in
`files`. The brief's list was followed literally, so `pnpm pack` ships `lib/index.js` containing a
`//# sourceMappingURL=index.js.map` comment whose target is not in the tarball. (The reference plugin
avoids this only because it builds no host sourcemap at all.) Adding `lib/index.js.map` to `files` —
or dropping the host sourcemap — would make the manifest self-consistent; flagged rather than changed
because `files` was explicitly enumerated.

### 5.3 `README.md` is referenced but not in scope

`files` lists `README.md`; the brief's writable scope does not include it, so it was not created.
`pnpm pack` handles the absent entry without error (see §4.8). Presumably a later task or the repo
owner adds it.

## 6. Not-applicable / notes for later tasks

### 6.1 Nothing is wired yet (by design)

`src/index.ts` registers no route and `src/client/index.tsx` registers no slot; `src/wire-types.ts`
is not imported by either half. That is the intended Task 1 stub state — the point of this task was
the build pipeline and the browser-bundle wrapper.

### 6.2 Task 3 will need extra devDependencies to type `ctx.slots`

Probed directly: with the current devDependency set, `void ctx.slots` in `src/client/index.tsx` fails
`tsc --noEmit` with `error TS2339: Property 'slots' does not exist on type 'Context'`. No installed
package in the current devDeps augments the Cordis `Context` with `slots`
(`@deepseek-ai/dsh-client-ui-slots` is not a devDependency). Task 3 must add
`@deepseek-ai/dsh-client-ui-slots` — and probably `@deepseek-ai/dsh-client-ui-renderer`,
`-layout`, `-sidebar` for the `sidebar.footer.action` slot contract — to `devDependencies` to get
typed slot registration. The stub's `export const inject = ['slots']` is a plain string array and is
unaffected.

### 6.3 Live/manual checks are out of scope for Task 1

The plugin is not installed into a DSH profile and no live provider call is made yet, so the PLAN's
manual checklist (§6.4) and boot audit (§6.5) are **not applicable** to this task. `usageUrl` and
`apiKeyEnv` are inert defaults here.
