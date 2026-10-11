/**
 * Authenticated fetch of the OpenCode Go quota endpoint, classified into the
 * shared {@link UsageEnvelope} shape.
 *
 * Secret safety is the whole point of this module's error handling: the key
 * travels only in the request's `Authorization` header, and every `message`
 * written into a failure envelope is a fixed, safe phrase (or the upstream
 * status code). The key, the `Authorization` header, and the raw response body
 * must never reach a message, a log line, or a response body.
 *
 * Network access is injectable (`fetchImpl`) so tests never touch the wire, and
 * the clock is injectable (`now`) so `fetchedAt` is deterministic under test.
 */
import packageJson from '../package.json' with { type: 'json' }
import type { UsageEnvelope } from './wire-types.js'
import { parseUsagePayload } from './quota-parse.js'

/** Everything {@link fetchQuota} needs; `fetchImpl` and `now` are test seams. */
export interface FetchQuotaDeps {
  /** Absolute quota endpoint URL. */
  url: string
  /** Credential value; sent only as `Authorization: Bearer <key>`. */
  apiKey: string
  /** Per-request deadline in milliseconds. */
  timeoutMs: number
  /** Display label copied into the snapshot. */
  label: string
  /** Fetch implementation; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Clock in epoch milliseconds; defaults to `Date.now`. */
  now?: () => number
}

/**
 * `User-Agent` value. The version is read from the package manifest so a
 * release bump cannot leave the header stale.
 */
export const USER_AGENT = `${packageJson.name}/${packageJson.version}`

/**
 * Perform one authenticated quota read.
 * @param deps - url, key, deadline, label, and the optional test seams.
 * @returns a success envelope, or a classified failure envelope free of secrets.
 */
export async function fetchQuota(deps: FetchQuotaDeps): Promise<UsageEnvelope> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now

  let response: Response
  try {
    response = await fetchImpl(deps.url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      // AbortSignal.timeout covers both the connect and the body read; a thrown
      // RangeError for a nonsense deadline lands in the same catch as a timeout.
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
  } catch {
    return {
      ok: false,
      reason: 'network',
      message: 'provider request failed (network or timeout)',
    }
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: 'key-invalid',
      status: response.status,
      message: `provider rejected the credential (${response.status})`,
    }
  }

  if (response.status === 404) {
    return {
      ok: false,
      reason: 'not-found',
      status: 404,
      // The URL itself is operator configuration; name the field instead of
      // echoing a value that may carry deployment-specific path segments.
      message: 'usage endpoint not found (404); check the configured usageUrl',
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: 'http',
      status: response.status,
      message: `provider returned HTTP ${response.status}`,
    }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, reason: 'parse', message: 'provider returned a non-JSON body' }
  }

  const parsed = parseUsagePayload(body)
  if (!parsed.ok) return { ok: false, reason: 'parse', message: parsed.message }

  return {
    ok: true,
    snapshot: {
      label: deps.label,
      fetchedAt: new Date(now()).toISOString(),
      stale: false,
      limitReached: parsed.limitReached,
      binding: parsed.binding,
      windows: parsed.windows,
    },
  }
}
