/**
 * Pure validator/parser for the OpenCode Go `GET /zen/go/v1/usage` payload.
 *
 * The upstream endpoint is official but undocumented, so this module is
 * deliberately lenient: individual windows that drift out of shape are DROPPED,
 * not treated as fatal, because one renamed or newly added window must not take
 * the whole widget down. The read is only a `parse` failure when there is no
 * usable `usage` object or when not a single window survives validation.
 *
 * Safety rules (see `docs/opencode-go-usage-api.md`):
 * - a window is valid only when `status ∈ {ok, rate-limited}`, `percent` is a
 *   finite number in `[0, 100]`, and `resetsAt` is a non-empty string whose
 *   `Date.parse` is finite;
 * - `percentUsed = status === 'rate-limited' ? 1 : percent / 100`;
 * - `limitReached = status === 'rate-limited' || percent === 100`.
 *
 * Pure: no I/O, no imports beyond the shared wire types, never throws.
 */
import type { QuotaWindow, QuotaWindowStatus } from './wire-types.js'

/** Result of {@link parseUsagePayload}. */
export type ParseUsageResult =
  | {
      ok: true
      windows: QuotaWindow[]
      /** `id` of the window with the highest `percentUsed`, or `null` when none parsed. */
      binding: string | null
      /** True when at least one window is exhausted. */
      limitReached: boolean
    }
  | { ok: false; reason: 'parse'; message: string }

/** One provider window key plus the label the widget shows for it. */
interface WindowSpec {
  readonly key: string
  readonly label: string
}

/**
 * The only provider keys we understand, ordered by horizon (shortest first).
 *
 * The order is load-bearing: the binding scan below uses a strict `>` so an
 * equal `percentUsed` keeps the earlier — shorter — window, which is the
 * documented tie-break (`rolling` > `weekly` > `monthly`).
 */
const WINDOW_SPECS: readonly WindowSpec[] = [
  { key: 'rolling', label: '5h' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
]

/** Message shared by every parse failure; it carries no payload content. */
const PARSE_MESSAGE = 'response carried no usable usage windows'

/** Narrow `unknown` to a plain (non-array, non-null) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one raw provider window and normalise it.
 * @param spec - the provider key and widget label for this window.
 * @param raw - the raw field value from the payload.
 * @returns the normalised window, or `undefined` when it must be dropped.
 */
function normaliseWindow(spec: WindowSpec, raw: unknown): QuotaWindow | undefined {
  if (!isRecord(raw)) return undefined

  const status = raw.status
  if (status !== 'ok' && status !== 'rate-limited') return undefined

  const percent = raw.percent
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return undefined
  }

  const resetsAt = raw.resetsAt
  if (typeof resetsAt !== 'string' || resetsAt.trim() === '') return undefined
  if (!Number.isFinite(Date.parse(resetsAt))) return undefined

  const resolved: QuotaWindowStatus = status
  return {
    id: spec.key,
    label: spec.label,
    status: resolved,
    // `rate-limited` means exhausted regardless of the reported percent.
    percentUsed: resolved === 'rate-limited' ? 1 : percent / 100,
    resetsAt,
    limitReached: resolved === 'rate-limited' || percent === 100,
  }
}

/**
 * Parse a decoded provider payload into normalised quota windows.
 * @param payload - the JSON-decoded body (any shape; never trusted).
 * @returns the windows plus the binding window, or a `parse` failure envelope.
 */
export function parseUsagePayload(payload: unknown): ParseUsageResult {
  if (!isRecord(payload)) return { ok: false, reason: 'parse', message: PARSE_MESSAGE }

  const usage = payload.usage
  if (!isRecord(usage)) return { ok: false, reason: 'parse', message: PARSE_MESSAGE }

  const windows: QuotaWindow[] = []
  let binding: string | null = null
  let bindingUsed = -1
  let limitReached = false

  // Iterate only the three known keys, shortest horizon first (tie-break order).
  for (const spec of WINDOW_SPECS) {
    const window = normaliseWindow(spec, usage[spec.key])
    if (window === undefined) continue

    windows.push(window)
    if (window.limitReached) limitReached = true
    // Strict `>` keeps the earlier (shorter) window on a tie.
    if (window.percentUsed > bindingUsed) {
      bindingUsed = window.percentUsed
      binding = window.id
    }
  }

  if (windows.length === 0) return { ok: false, reason: 'parse', message: PARSE_MESSAGE }

  return { ok: true, windows, binding, limitReached }
}
