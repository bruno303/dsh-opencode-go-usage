# Installing `dsh-opencode-go-usage`

This plugin installs into a **DSH profile** — for the Web GUI that is the `web`
profile, stored under `$DSH_HOME/profiles/web/`. It is an out-of-tree plugin: it
is added as a profile dependency and selected as a **bundle**.

Two things every install must end with:

1. the package is a dependency of the profile, and
2. its bundle is **selected** (present in the profile's `dsh.profile.bundles`).

Selecting the bundle is what applies the plugin's own patch (this package's
[`cordis.patch.yml`](../cordis.patch.yml)), which inserts the host row. The package's
`dsh.client` manifest is what supplies the browser half (`lib/client.js`) to the
`web` platform.

> **This document was not executed against a live profile.** It was written from the
> shipped CLI's own `--help` output, the CLI's argument grammar, and the
> `dsh-plugin-manager` package README. Details that could not be verified in this
> environment are marked **unverified** below. Nothing here has been run against a
> running profile, and no plugin was installed while writing it.

## Before you start

The install uses the **build output**, not the sources:

```bash
cd /absolute/path/to/dsh-opencode-go-usage
pnpm install
pnpm run build
```

`pnpm run build` emits `lib/index.js`, `lib/index.d.ts`, `lib/client.js` and
`lib/client.js.map` (plus `lib/index.js.map`). DSH resolves the host half from
`package.json` → `exports["."]` → `lib/index.js`, and the browser half from
`dsh.client` → `lib/client.js`. A selected bundle whose `lib/client.js` is missing
fails activation loudly — see [docs/testing.md](testing.md).

Also confirm the runtime is inside the declared range (see the
[README](../README.md#requirements)):

```bash
dsh --version        # verified against 0.2.0-rc.2
node --version       # >= 20
```

## Path A (recommended): the Web GUI's Plugins page

The plugin manager performs the whole install — dependency, bundle selection and
activation — and reports pnpm's output; nothing has to be edited by hand.

1. Open the Web GUI and select **Plugins** in the sidebar.
2. Click **Add plugin**.
3. Enter the **absolute local path** to this package, e.g.
   `/absolute/path/to/dsh-opencode-go-usage`. (The field accepts a package name
   with an optional version, a Git address, a tarball, or an absolute local path.)
4. Optionally click **Install guide and examples** first; it explains the accepted
   spec forms. The trust box notes that installed plugins do not update
   automatically.
5. Click **Install**. The Host reads the spec, then starts pnpm; pnpm's command and
   output are behind **Show install details**, and **Cancel install** is available
   while it runs.
6. When it finishes, click **Enable now** on the success screen. Per the
   plugin-manager README, installation enables a new bundle by default; **Enable
   now** is the explicit control that makes it certain and scrolls the list to the
   new card.

The plugin then appears under **Installed**. Its card exposes the settings form
generated from the plugin's `Config` schema — see
[Key configuration](#key-configuration).

## Path B (CLI): forwarding to pnpm

The launcher's own help (verified — `dsh --help`) documents this form:

```
Usage: dsh [--profile] <name> [options] [app-args...]
       dsh plugin --profile <name> <pnpm-args...>
...
  dsh plugin --profile tui add <package>    install a plugin into the tui profile
```

So the CLI entry point is `dsh plugin`, and **`--profile <name>` is required**
(verified — running `dsh plugin --help` with no profile exits nonzero with
`error: required option '--profile <name>' not specified`). Everything after
`--profile <name>` is forwarded **verbatim to pnpm**, run in the profile
directory.

Install from the absolute local path:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-opencode-go-usage
```

`add <spec>` is the command named in the launcher's own example, and the plugin
manager reads an absolute local path by parsing that path's `package.json`.
Selecting the bundle after a successful `add` is the plugin manager's job: the
plugin-manager README states "Installation enables a new bundle by default."
Whether `dsh plugin add` selects the bundle exactly as the GUI does is
**unverified** here — the CLI could not be executed in this environment (see
[Environment limits](#environment-limits-while-writing-this-document)). Confirm
selection with the check in [Verification](#verification), and if the bundle is not
selected, select it on the Plugins page (Path A) or in the profile manifest
(Manual fallback).

To install a **published or hosted** copy instead of a local path, pass pnpm's own
spec:

```bash
dsh plugin --profile web add dsh-opencode-go-usage@0.1.0
dsh plugin --profile web add github:<owner>/<repo>#v0.1.0
```

Those spec forms are pnpm's and are accepted by the same forwarding rule. They are
**not usable today**: this package's v1 scope has no npm publish, so a local path (or
a Git address once the repository is hosted) is the supported install source —
`PLAN.md` §8.3 leaves publishing as a later decision.

If pnpm is not on `PATH`, the CLI prints `dsh: pnpm was not found; install pnpm and
make it available on PATH.` A failed run prints its diagnostics log path. When a
dependency's install scripts are blocked by pnpm, the failed install lists the
pending packages and the GUI offers **Allow these scripts and retry**; the CLI
guidance is the one the CLI prints itself (adding the exact key pnpm named under
`allowBuilds` in the profile's `pnpm-workspace.yaml`). This package declares no
`install`/`postinstall`/`prepare` script, so a normal path install should not reach
that path.

## Manual fallback

If neither path is available, make the two changes yourself. The profile lives at:

| Path | Role |
|---|---|
| `$DSH_HOME/profiles/web/package.json` | Profile manifest: `dependencies` **and** `dsh.profile.bundles` |
| `$DSH_HOME/profiles/web/cordis.patch.yml` | The profile's own patch layer (applied after every bundle layer) |

`$DSH_HOME` defaults to `~/.dsh`.

### 1. Add the dependency and select the bundle

In `$DSH_HOME/profiles/web/package.json`:

```json
{
  "dependencies": {
    "dsh-opencode-go-usage": "file:/absolute/path/to/dsh-opencode-go-usage"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-opencode-go-usage"
      ]
    }
  }
}
```

Then install the dependency the way the profile normally does (the plugin manager's
own `pnpm add`, with the profile directory as the working directory) so it appears
in `$DSH_HOME/profiles/web/node_modules/`.

### 2. If — and only if — the bundle is not selectable

Selecting the bundle in `dsh.profile.bundles` makes DSH apply this package's own
patch. The patch is exactly:

```yaml
- insert:
    - id: dsh-opencode-go-usage
      name: dsh-opencode-go-usage
```

This is the verbatim content of this package's `cordis.patch.yml`. Pasting it into
`$DSH_HOME/profiles/web/cordis.patch.yml` is the equivalent explicit insert for a
setup where the package is loaded as a plain dependency rather than as a selected
bundle.

> **Warning:** do not do both. If the bundle is selected, DSH already applies the
> patch above; inserting the same row again in the profile layer duplicates the
> entry (and its exact routes), and the webserver throws on a duplicate path at
> load time.

## Key configuration

The plugin never stores a secret. Its `apiKeyEnv` field (default
`OPENCODE_GO_API_KEY`) names a **credential reference**, and the host resolves the
value per fetch through the DSH credential seam.

Resolution order, per the `dsh-credentials` README:

1. **The launching environment wins for that run.** `OPENCODE_GO_API_KEY=… dsh web`
   (or a CI secret, or a container `-e`) is used and reported **read-only**; the
   store cannot override it.
2. Otherwise the value comes from the credential store at
   `$DSH_HOME/.credentials.yaml`, from its top-level `refs` map:

   ```yaml
   version: 1
   records:
     # …durable per-plugin records…
   refs:
     DEEPSEEK_API_KEY: <value>
     OPENCODE_GO_API_KEY: <value>
   ```

   The `refs` keys are the reference names. An **empty** value counts as absent.

The key is shared with the LLM adapter that already talks to `opencode-go`: the
profile's `dsh-llm-pi-ai` provider config takes the same reference name. If that
provider already works, this plugin needs no key work at all.

### Confirm the reference is present without printing the secret

This prints a word, never the value:

```bash
grep -qE '^[[:space:]]+OPENCODE_GO_API_KEY:' "${DSH_HOME:-$HOME/.dsh}/.credentials.yaml" \
  && echo "reference is present" \
  || echo "reference is missing"
```

Do **not** run a bare `grep OPENCODE_GO_API_KEY …` (or `cat …`) without `-q`/`-c`:
the matching line contains the secret value. The plugin itself never logs or returns
it either — a missing reference is reported by *name* (`key-missing`, "credential
OPENCODE_GO_API_KEY is not set").

To change the reference name, set `apiKeyEnv` to another `refs` key. To use a
different secret entirely, add it to the store under the name you set.

## Verification

### 1. The plugin row is composed

```bash
dsh --profile web --dump-config
```

The composed tree must contain a `dsh-opencode-go-usage` entry. `--dump-config` is
listed by `dsh --help`; note that it runs the profile's preparation step and
therefore needs **write access to `$DSH_HOME`** (it rewrites the profile's
generated `cordis.yml`). It could not be executed while writing this document — see
[Environment limits](#environment-limits-while-writing-this-document).

### 2. The routes are registered and authenticated

With the GUI running (default `http://127.0.0.1:3080`), an **unauthenticated** call
must be refused — no unauthenticated reads are possible:

```bash
curl -i http://127.0.0.1:3080/__dsh_opencode_go_usage__/usage
```

Expected: `401` or `403` (the status is passed through from the browser-trust
admission check). A `200` here would mean the fence is down and should be treated
as a bug.

### 3. The widget is visible

Reload the GUI. The indicator appears at the **sidebar foot**, in both the wide
sidebar and the collapsed rail. Open it: the popover lists the windows with a reset
countdown, the fetch age, and a **Refresh** button. A successful reading with three
windows confirms the host reached the provider with the resolved key.

If it does not appear, start with [docs/testing.md](testing.md#troubleshooting)
(widget missing ⇒ the bundle is not selected, or `lib/client.js` was never built).

## Uninstalling

1. **Deselect the bundle.** On the Plugins page, switch the bundle off — or, if you
   are uninstalling entirely, use the page's uninstall action (that it asks for
   confirmation is **unverified** here — the shipped UI was not exercised while
   writing this document). Deselecting unloads the two routes and the sidebar
   indicator without touching the package.
2. **Remove the dependency.** From the GUI this is the same uninstall action; from
   the CLI:

   ```bash
   dsh plugin --profile web remove dsh-opencode-go-usage
   ```

   Per the plugin-manager README, removal removes the bundle from
   `dsh.profile.bundles`, unloads its runtime contributions, and *then* runs pnpm.

If you installed by hand, reverse the manual steps above: drop any row you pasted
into `cordis.patch.yml`, drop the bundle name from `dsh.profile.bundles`, then remove
the dependency.

## While the GUI is running

With HMR enabled in the profile's YAML, the plugin manager serializes configuration
reloads and a profile change **recomposes the running tree** — installing or
switching a bundle can hot-reload the GUI and its client module graph mid-session.
Without HMR, changes apply on restart.

If the result looks wrong, or if the sidebar does not repaint after a switch,
**restart `dsh web`** and check again before investigating further. The plugin
manager's own limitations note that package *replacements* (not switches) always
need a fresh process to load new JavaScript.

## Environment limits while writing this document

Recorded so the reader knows exactly what is verified and what is not:

| Attempt | Result |
|---|---|
| `dsh --help` | Verified. Shows `dsh plugin --profile <name> <pnpm-args...>` and the `dsh plugin --profile tui add <package>` example. |
| `dsh plugin --help` | Exits nonzero: `error: required option '--profile <name>' not specified`. Confirms `--profile` is mandatory. |
| `dsh plugin --profile web --help` | **Not verifiable here.** The CLI does not own a `--help` for this command: `--help` is not one of the three DSH-owned verbs, so it is routed to the plugin manager's package operation, which first takes the profile write lock and fails with `EROFS: read-only file system, open '/home/bruno/.dsh/profiles/web/package.json.lock'` — the sandbox denies writes under `$DSH_HOME`. The "pnpm arguments, forwarded verbatim" wording comes from the launcher's own argument definition, whose examples name `add <pkg>`, `remove <pkg>`, and `why <pkg>`. |
| `dsh --profile web --dump-config` | **Not verifiable here.** Fails with `EROFS: read-only file system, open '/home/bruno/.dsh/profiles/web/cordis.yml'`; profile preparation writes that file. |
| `dsh plugin --profile web add …` | **Deliberately not run** — installing into a live profile is out of scope for this document. |

Because of those sandbox denials, the following are documented from the shipped
READMEs and the CLI's own grammar rather than from an executed install: the exact
GUI button labels, whether `dsh plugin add` selects the bundle the same way the GUI
does, and all expected `--dump-config` output.
