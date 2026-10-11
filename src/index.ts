import type { Context } from '@deepseek-ai/cordis'
import {
  credentialRef,
  isCredentialRefName,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
// Type-only: also what declares `ctx.webServer` on the Cordis `Context`, and it
// pins the registered object to the installed `WebRoute` contract.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import Schema from '@deepseek-ai/schemastery'
import { createSnapshotCache } from './cache.js'
import { fetchQuota } from './quota-provider.js'
import { createUsageHandler, REFRESH_ROUTE, USAGE_ROUTE } from './route.js'
import type { UsageEnvelope } from './wire-types.js'

/**
 * Host half of `dsh-opencode-go-usage`.
 *
 * A plain Cordis plugin. DSH's Loader identifies the settings form by the entry
 * id (`dsh-opencode-go-usage` in `cordis.patch.yml`), and the exported
 * {@link Config} schema IS that form — so the field set below is the operator
 * surface, and no credential value may ever appear in it (only the *name* of the
 * credential reference).
 */

/** Loader entry id; also the settings storage namespace. Must not change. */
export const name = 'dsh-opencode-go-usage'

/**
 * Host services this plugin needs. Verified against the installed DSH runtime
 * type declarations (`0.2.0-rc.2`):
 *
 * - `webServer` — `@deepseek-ai/dsh-host-webserver` (`lib/types/index.d.ts`),
 *   declares `webServer: WebServer` on the Cordis `Context`.
 * - `credentials` — `@deepseek-ai/dsh-credentials` (`lib/types/index.d.ts`),
 *   declares `credentials: CredentialProvider`.
 * - `connection` — `@deepseek-ai/dsh-client-connection` (`lib/types/rpc-host.d.ts`),
 *   declares `connection: HostConnectionHandle` (the browser-trust seam used by
 *   `admit()`).
 */
export const inject = ['webServer', 'credentials', 'connection']

/**
 * Operator-facing configuration.
 *
 * Every field has a working default, so a fresh install is usable as-is; add a
 * `config:` block under the plugin row only to override something.
 */
export const Config = Schema.object({
  apiKeyEnv: Schema.string()
    .default('OPENCODE_GO_API_KEY')
    .description(
      'Credential reference resolved through the DSH credential seam. This is the *name* of the secret, never its value.',
    ),
  usageUrl: Schema.string()
    .default('https://opencode.ai/zen/go/v1/usage')
    .description(
      'OpenCode Go quota endpoint. Undocumented upstream, so it stays configurable in case it moves.',
    ),
  displayName: Schema.string()
    .default('OpenCode Go')
    .description('Label shown on the usage widget and popover.'),
  refreshSeconds: Schema.number()
    .default(60)
    .description(
      'How long a fetched snapshot is served before another provider request is made.',
    ),
  timeoutMs: Schema.number()
    .default(10000)
    .description('Deadline for a single provider request, in milliseconds.'),
})

/**
 * The Loader config as it arrives in `apply`, before defaults are applied. Only
 * used to type the schema call; the schema fills every field.
 */
interface RawPluginConfig {
  apiKeyEnv?: string
  usageUrl?: string
  displayName?: string
  refreshSeconds?: number
  timeoutMs?: number
}

/** The config values the envelope loader reads, with schema defaults applied. */
export interface UsageLoaderConfig {
  /** Credential *reference* name resolved through the seam (never a value). */
  apiKeyEnv: string
  /** Provider quota endpoint. */
  usageUrl: string
  /** Display label copied into the snapshot. */
  displayName: string
  /** Per-request deadline in milliseconds. */
  timeoutMs: number
}

/**
 * Dependencies of the real envelope loader.
 *
 * Extracted so the credential-resolution path is unit-testable without a live
 * Cordis runtime: `apply` wires the runtime seams in, and a test can drive the
 * same logic with a fake resolver and a fake provider fetch.
 */
export interface EnvelopeLoaderDeps {
  /**
   * Credential seam (`ctx.credentials.resolve` in production). Resolves the
   * reference to `{ value, source }`, or to `undefined` when nothing is stored
   * for it. The resolved value must never be logged, echoed, or cached.
   */
  resolveCredential: (ref: CredentialRef) => Promise<ResolvedCredential | undefined>
  /** Provider read seam. @default fetchQuota */
  fetchQuotaImpl?: typeof fetchQuota
  /** Clock seam forwarded to the provider read (deterministic `fetchedAt`). */
  now?: () => number
}

/**
 * Build the loader that resolves the credential and reads the provider.
 *
 * Runs on every cache miss. The resolved value is never captured in module
 * state and never copied into a returned envelope — only the quota windows are —
 * so a rotated key is picked up by the next fetch and a credential can never
 * travel back to the browser.
 *
 * @param config - the plugin config with defaults applied.
 * @param deps - credential seam, provider fetch seam, optional clock.
 * @returns the async loader used as `loadEnvelope` by the route handler.
 */
export function createEnvelopeLoader(
  config: UsageLoaderConfig,
  deps: EnvelopeLoaderDeps,
): () => Promise<UsageEnvelope> {
  const fetchQuotaImpl = deps.fetchQuotaImpl ?? fetchQuota

  return async function loadEnvelope(): Promise<UsageEnvelope> {
    // A name outside the reference grammar has no reference to miss: report it
    // as unset instead of letting `credentialRef` throw. The value is NOT
    // echoed — an operator who pasted a key into this field must not see it
    // reflected back through the route.
    if (!isCredentialRefName(config.apiKeyEnv)) {
      return {
        ok: false,
        reason: 'key-missing',
        message: 'the configured apiKeyEnv is not a valid credential reference name',
      }
    }

    const hit = await deps.resolveCredential(credentialRef(config.apiKeyEnv))
    if (hit === undefined) {
      // Names the reference, never a value.
      return {
        ok: false,
        reason: 'key-missing',
        message: `credential ${config.apiKeyEnv} is not set`,
      }
    }

    return fetchQuotaImpl({
      url: config.usageUrl,
      apiKey: hit.value,
      timeoutMs: config.timeoutMs,
      label: config.displayName,
      now: deps.now,
    })
  }
}

/**
 * Cordis entry point.
 *
 * Wires the pure host half to the runtime: one TTL cache, one provider loader
 * that resolves the credential per call (so a rotated key applies without a
 * restart), and the two exact routes registered on the host web server. Both
 * registrations are owned by one `ctx.effect`, so plugin unload removes them.
 *
 * @param ctx - the plugin context (injects `webServer`, `credentials`, `connection`).
 * @param rawConfig - the Loader config for this entry, validated against {@link Config}.
 */
export async function apply(ctx: Context, rawConfig: unknown): Promise<void> {
  const config = Config(rawConfig as RawPluginConfig | null | undefined)

  const cache = createSnapshotCache({ ttlMs: config.refreshSeconds * 1000 })

  const loadEnvelope = createEnvelopeLoader(
    {
      apiKeyEnv: config.apiKeyEnv,
      usageUrl: config.usageUrl,
      displayName: config.displayName,
      timeoutMs: config.timeoutMs,
    },
    { resolveCredential: (ref) => ctx.credentials.resolve(ref) },
  )

  const handler = createUsageHandler({
    cache,
    loadEnvelope,
    admit: (req) => ctx.connection.admit(req),
  })

  ctx.effect(() => {
    const usageRoute: WebRoute = { kind: 'exact', path: USAGE_ROUTE, handler }
    const refreshRoute: WebRoute = { kind: 'exact', path: REFRESH_ROUTE, handler }
    const disposeUsage = ctx.webServer.register(usageRoute)
    try {
      const disposeRefresh = ctx.webServer.register(refreshRoute)
      return () => {
        // Reverse registration order; both disposers are idempotent.
        disposeRefresh()
        disposeUsage()
      }
    } catch (error) {
      // A duplicate-path collision throws from the second register; do not leave
      // the first route mounted on a failed activation.
      disposeUsage()
      throw error
    }
  }, 'dsh-opencode-go-usage quota routes')
}
