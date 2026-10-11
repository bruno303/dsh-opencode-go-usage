/**
 * Browser-half view model: the pure decisions behind {@link UsageIndicator}.
 *
 * React-free and DOM-free on purpose — every formatting, severity, and copy
 * decision the widget makes is a plain function of the `UsageEnvelope` the host
 * route returned, so it is unit-testable in a node environment with no renderer
 * and no fetch.
 *
 * Copy discipline: the widget renders ONLY the fixed strings below, never a
 * server-provided `message`. The host already keeps credentials out of its
 * envelopes, and ignoring its free text on the client means a future host
 * regression still cannot paint a secret into the sidebar.
 */
import type { QuotaWindow, UsageEnvelope, UsageFailureReason } from '../wire-types.js'

/**
 * The two host routes and the one response header this half reads. Declared
 * client-locally rather than imported from `src/route.ts`: that module is
 * node-side code (it imports `node:http` types and the cache), and pulling it in
 * would drag host code into the browser bundle. `usage-view.test.ts` pins the
 * literals as a drift guard.
 */
export const USAGE_PATH = '/__dsh_opencode_go_usage__/usage'
/** POST route that bypasses the host TTL (the popover's Refresh button). */
export const REFRESH_PATH = '/__dsh_opencode_go_usage__/refresh'

/**
 * Response header carrying the age the **host** measured for the snapshot it
 * just served (`src/route.ts` sets it on every snapshot-bearing response).
 *
 * Duplicated as a literal here for the same reason as the two route paths: this
 * module must not import host code. `src/route.test.ts` pins the host side and
 * `usage-view.test.ts` pins this literal.
 */
export const SNAPSHOT_AGE_HEADER = 'X-Usage-Snapshot-Age-Ms'

/** Traffic-light state for one window (or for the binding window overall). */
export type WindowSeverity = 'ok' | 'warning' | 'critical'

/** One window row in the popover. */
export interface UsageWindowView {
  id: string
  label: string
  /**
   * Compact label for the always-visible indicator (`5h`, `wk`, `mo`), where all
   * three windows share one sidebar row.
   */
  shortLabel: string
  /** Clamped, rounded percentage as display text (`19%`). */
  percentText: string
  severity: WindowSeverity
  /** Compact countdown to `resetsAt` (`in 3d 4h`, `now`, `unknown`). */
  resetsIn: string
  limitReached: boolean
}

/** A readable snapshot. */
export interface UsageOkView {
  kind: 'ok'
  label: string
  /** `id` of the window with the highest usage, or `null` when none parsed. */
  binding: string | null
  /** Percentage text of the binding window, or {@link NO_WINDOW_TEXT}. */
  percentText: string
  severity: WindowSeverity
  stale: boolean
  /**
   * Relative age of the snapshot (`just now`, `4m ago`, `unknown`): the host's
   * own age measurement when it reported one, else derived from `fetchedAt`.
   */
  fetchedAtText: string
  windows: UsageWindowView[]
}

/** Nothing has loaded yet. */
export interface UsageLoadingView {
  kind: 'loading'
}

/** The read failed; `message` is fixed copy, never server text. */
export interface UsageErrorView {
  kind: 'error'
  reason: UsageFailureReason
  message: string
  /** Server-provided HTTP status, surfaced whenever the envelope carried one. */
  status?: number
}

/** Discriminated view model consumed by the component. */
export type UsageView = UsageLoadingView | UsageOkView | UsageErrorView

/**
 * One read of a host route: the envelope plus the host's own measurement of how
 * old the snapshot it served already was.
 *
 * `serverAgeMs` comes from {@link SNAPSHOT_AGE_HEADER} and is what makes the
 * "updated … ago" text immune to browser/server clock skew: the host stamps and
 * ages the snapshot, so its delta is authoritative. It is `undefined` when the
 * host sent no usable header, and the view then falls back to
 * `now - snapshot.fetchedAt`.
 */
export interface UsageRead {
  envelope: UsageEnvelope
  serverAgeMs?: number
}

/** Shown when the snapshot parsed but has no binding window to report. */
export const NO_WINDOW_TEXT = '—'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** Severity flips to `warning` at four fifths of a window. */
const WARNING_AT = 0.8

/** Fixed, secret-free operator copy per failure reason. */
const FAILURE_COPY: Record<UsageFailureReason, string> = {
  'key-missing': 'No API key is configured for this provider.',
  'key-invalid': 'The configured API key was rejected.',
  'not-found': 'The usage endpoint was not found.',
  network: 'Could not reach the usage endpoint.',
  parse: 'The usage response could not be read.',
  http: 'The usage endpoint returned an error.',
}

/** Every reason the wire union may carry, for runtime validation. */
const FAILURE_REASONS: readonly UsageFailureReason[] = [
  'key-missing',
  'key-invalid',
  'not-found',
  'network',
  'parse',
  'http',
]

/** Fixed copy for a reason, resilient to a host that adds a new reason. */
function failureCopy(reason: UsageFailureReason): string {
  return FAILURE_COPY[reason] ?? FAILURE_COPY.http
}

/**
 * Render a fraction as a whole percentage.
 * @param percentUsed - fraction in `[0, 1]`; out-of-range and non-finite values clamp.
 * @returns display text such as `0%`, `19%`, `100%`.
 */
export function formatPercent(percentUsed: number): string {
  // A non-finite reading is a bug upstream, not a 100% window: fail down to 0
  // so the widget can never paint an exhausted-looking state from bad math.
  const clamped = Number.isFinite(percentUsed) ? Math.min(1, Math.max(0, percentUsed)) : 0
  return `${String(Math.round(clamped * 100))}%`
}

/**
 * Compact countdown to an instant.
 * @param resetsAt - ISO-8601 reset instant.
 * @param nowMs - current time in epoch milliseconds.
 * @returns `in 3d 4h` / `in 5h 12m` / `in 47m` / `in 30s`, `now` once due, or `unknown` when unparseable.
 */
export function formatCountdown(resetsAt: string, nowMs: number): string {
  const target = Date.parse(resetsAt)
  if (!Number.isFinite(target)) return 'unknown'

  const delta = target - nowMs
  if (delta <= 0) return 'now'

  const days = Math.floor(delta / DAY_MS)
  const hours = Math.floor((delta % DAY_MS) / HOUR_MS)
  const minutes = Math.floor((delta % HOUR_MS) / MINUTE_MS)
  const seconds = Math.floor((delta % MINUTE_MS) / 1000)

  // At most two units, coarse to fine: a countdown is a glance, not a clock.
  if (days > 0) return hours > 0 ? `in ${String(days)}d ${String(hours)}h` : `in ${String(days)}d`
  if (hours > 0) return minutes > 0 ? `in ${String(hours)}h ${String(minutes)}m` : `in ${String(hours)}h`
  if (minutes > 0) return `in ${String(minutes)}m`
  return `in ${String(seconds)}s`
}

/**
 * Traffic-light state for one window.
 * @param percentUsed - fraction in `[0, 1]`.
 * @param limitReached - whether the provider refused the window.
 * @returns `critical` on a refused window, `warning` at/above 80%, else `ok`.
 */
export function windowSeverity(percentUsed: number, limitReached: boolean): WindowSeverity {
  if (limitReached) return 'critical'
  return percentUsed >= WARNING_AT ? 'warning' : 'ok'
}

/** Relative age text for a millisecond age; mirrors {@link formatCountdown}'s coarseness. */
function formatAge(ageMs: number): string {
  // A clock skew that dates the snapshot in the future is not worth explaining.
  if (ageMs < MINUTE_MS) return 'just now'
  if (ageMs < HOUR_MS) return `${String(Math.floor(ageMs / MINUTE_MS))}m ago`
  if (ageMs < DAY_MS) return `${String(Math.floor(ageMs / HOUR_MS))}h ago`
  return `${String(Math.floor(ageMs / DAY_MS))}d ago`
}

/**
 * "Updated…" text for a snapshot.
 *
 * The host-reported age wins when present: it is measured between two clocks the
 * host owns, while `now - fetchedAt` compares the server's `fetchedAt` with the
 * browser's clock and is wrong by however far those two clocks disagree. The
 * `fetchedAt` fallback keeps older hosts (and a proxied response that dropped
 * the header) readable.
 */
function formatElapsed(serverAgeMs: number | undefined, fetchedAt: string, nowMs: number): string {
  if (serverAgeMs !== undefined) return formatAge(Math.max(0, serverAgeMs))
  const at = Date.parse(fetchedAt)
  if (!Number.isFinite(at)) return 'unknown'
  return formatAge(nowMs - at)
}

/**
 * Read the host's snapshot-age header value.
 * @param raw - the raw header value, or `null` when the header is absent.
 * @returns the age in milliseconds, or `undefined` when absent or unusable.
 */
export function parseServerAgeMs(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  // `Number('')` is 0 and `Number('12ms')` is NaN: require a plain, non-negative
  // finite number so a proxy that rewrites or duplicates the header degrades to
  // the `fetchedAt` fallback instead of printing a wrong age.
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return undefined
  return value
}

/**
 * Turn a host envelope into the component's view model.
 * @param envelope - the host's envelope, or `undefined` before the first read.
 * @param nowMs - current time in epoch milliseconds, used for the relative copy.
 * @param serverAgeMs - host-measured snapshot age from {@link SNAPSHOT_AGE_HEADER}, when it sent one.
 * @returns the loading view, a readable snapshot, or fixed error copy.
 */
export function describeEnvelope(
  envelope: UsageEnvelope | undefined,
  nowMs: number,
  serverAgeMs?: number,
): UsageView {
  if (envelope === undefined) return { kind: 'loading' }

  if (!envelope.ok) {
    const view: UsageErrorView = {
      kind: 'error',
      reason: envelope.reason,
      message: failureCopy(envelope.reason),
    }
    if (envelope.status !== undefined) view.status = envelope.status
    return view
  }

  const { snapshot } = envelope
  const bindingWindow =
    snapshot.binding === null
      ? undefined
      : snapshot.windows.find((window) => window.id === snapshot.binding)

  const windows: UsageWindowView[] = snapshot.windows.map((window) => toWindowView(window, nowMs))

  return {
    kind: 'ok',
    label: snapshot.label,
    binding: snapshot.binding,
    percentText: bindingWindow === undefined ? NO_WINDOW_TEXT : formatPercent(bindingWindow.percentUsed),
    // With no binding window there is nothing to grade, so only the snapshot's
    // own limit flag can escalate the indicator.
    severity: windowSeverity(bindingWindow?.percentUsed ?? 0, bindingWindow?.limitReached ?? snapshot.limitReached),
    stale: snapshot.stale,
    fetchedAtText: formatElapsed(serverAgeMs, snapshot.fetchedAt, nowMs),
    windows,
  }
}

/** Project one wire window into its view row. */
function toWindowView(window: QuotaWindow, nowMs: number): UsageWindowView {
  return {
    id: window.id,
    label: window.label,
    shortLabel: shortWindowLabel(window.id, window.label),
    percentText: formatPercent(window.percentUsed),
    severity: windowSeverity(window.percentUsed, window.limitReached),
    resetsIn: formatCountdown(window.resetsAt, nowMs),
    limitReached: window.limitReached,
  }
}

/**
 * Compact labels for the always-visible indicator, keyed by window id.
 *
 * The indicator fits all three windows into one sidebar footer row, so the
 * popover's fuller labels (`Weekly`) are shortened in parallel (`wk`). A window
 * id the host adds later falls back to the first two characters of its label
 * rather than disappearing from the indicator.
 */
const SHORT_WINDOW_LABELS: Record<string, string> = {
  rolling: '5h',
  weekly: 'wk',
  monthly: 'mo',
}

/** Shortest label that still identifies one window. */
function shortWindowLabel(id: string, label: string): string {
  return SHORT_WINDOW_LABELS[id] ?? label.slice(0, 2)
}

/**
 * Whether a value is structurally a `QuotaWindow`.
 *
 * The bundle crosses a plugin boundary a future host version also crosses, so
 * this guards the fields the component dereferences; it is deliberately not a
 * full schema check.
 */
function isQuotaWindow(value: unknown): value is QuotaWindow {
  if (typeof value !== 'object' || value === null) return false
  const window = value as Record<string, unknown>
  return (
    typeof window.id === 'string' &&
    typeof window.label === 'string' &&
    (window.status === 'ok' || window.status === 'rate-limited') &&
    typeof window.percentUsed === 'number' &&
    typeof window.resetsAt === 'string' &&
    typeof window.limitReached === 'boolean'
  )
}

/** Whether a value is structurally the `UsageEnvelope` the component expects. */
function isUsageEnvelope(value: unknown): value is UsageEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const envelope = value as Record<string, unknown>

  if (envelope.ok === true) {
    const snapshot = envelope.snapshot
    if (typeof snapshot !== 'object' || snapshot === null) return false
    const fields = snapshot as Record<string, unknown>
    return (
      typeof fields.label === 'string' &&
      typeof fields.fetchedAt === 'string' &&
      typeof fields.stale === 'boolean' &&
      typeof fields.limitReached === 'boolean' &&
      (fields.binding === null || typeof fields.binding === 'string') &&
      Array.isArray(fields.windows) &&
      fields.windows.every(isQuotaWindow)
    )
  }

  if (envelope.ok === false) {
    return typeof envelope.reason === 'string' && FAILURE_REASONS.includes(envelope.reason as UsageFailureReason)
  }

  return false
}

/** A fixed, secret-free failure envelope produced without calling the host. */
function localFailure(reason: UsageFailureReason, status?: number): UsageEnvelope {
  const envelope: Extract<UsageEnvelope, { ok: false }> = {
    ok: false,
    reason,
    message: failureCopy(reason),
  }
  if (status !== undefined) envelope.status = status
  return envelope
}

/**
 * One authenticated same-origin read of a host route.
 *
 * Never throws: a rejecting `fetch`, an unreadable body, and a non-2xx status
 * all become failure envelopes, because a plugin that throws inside an event
 * handler takes the sidebar down with it.
 *
 * The host's snapshot-age header is read before the body so a host that reports
 * its own age makes the "updated … ago" text clock-skew-proof.
 */
async function requestUsage(
  fetchImpl: typeof fetch,
  url: string,
  method: 'GET' | 'POST',
): Promise<UsageRead> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method,
      headers: { Accept: 'application/json' },
      // The host authenticates the browser session with its cookie; no new
      // transport machinery and no credential ever reaches this half.
      credentials: 'same-origin',
    })
  } catch {
    return { envelope: localFailure('network') }
  }

  // The host answers 200 for its own failure envelopes, so a non-2xx is a
  // transport, admission, or routing failure rather than a quota verdict.
  if (!response.ok) {
    return {
      envelope:
        response.status === 404 ? localFailure('not-found', 404) : localFailure('http', response.status),
    }
  }

  const serverAgeMs = parseServerAgeMs(response.headers.get(SNAPSHOT_AGE_HEADER))

  let body: unknown
  try {
    body = await response.json()
  } catch {
    // A non-JSON body is an intermediary's page, not a quota reading.
    return { envelope: localFailure('network') }
  }

  if (!isUsageEnvelope(body)) return { envelope: localFailure('parse') }
  return serverAgeMs === undefined ? { envelope: body } : { envelope: body, serverAgeMs }
}

/**
 * `GET` the usage route.
 * @param fetchImpl - fetch seam (the platform `fetch` in production).
 * @param url - absolute or relative usage route URL.
 * @returns the host envelope plus the host's snapshot age when it sent one; never rejects.
 */
export function fetchUsage(fetchImpl: typeof fetch, url: string): Promise<UsageRead> {
  return requestUsage(fetchImpl, url, 'GET')
}

/**
 * `POST` the refresh route (bypasses the host TTL).
 * @param fetchImpl - fetch seam (the platform `fetch` in production).
 * @param url - absolute or relative refresh route URL.
 * @returns the host envelope plus the host's snapshot age when it sent one; never rejects.
 */
export function refreshUsage(fetchImpl: typeof fetch, url: string): Promise<UsageRead> {
  return requestUsage(fetchImpl, url, 'POST')
}

/*
 * Popover geometry.
 *
 * The widget is the `sidebar.footer.action` occupant: a full-width flex row at
 * the very left of the window, inside a column that is `overflow: hidden` and
 * only as wide as the column itself. An absolutely positioned panel anchored to
 * a button at the left of that row therefore grew leftwards past the window
 * edge (and/or was clipped by the column). The panel is positioned `fixed`
 * against the viewport instead, and clamped into it by `placePopover`.
 */

/** Width the popover asks for before clamping to the viewport. */
export const POPOVER_WIDTH = 260

/** Viewport gutter kept between the popover and each window edge. */
export const POPOVER_MARGIN = 8

/**
 * Minimum usable room above the anchor before the popover flips below it.
 *
 * This is not the panel's height: the panel is pinned by its own bottom edge, so
 * only the choice of side needs an estimate.
 */
export const POPOVER_MIN_ROOM = 140

/** The viewport-relative anchor box, as `getBoundingClientRect()` reports it. */
export interface AnchorRect {
  top: number
  bottom: number
  left: number
  right: number
}

/** Viewport extent in CSS pixels. */
export interface ViewportSize {
  width: number
  height: number
}

/** Fixed, viewport-clamped popover coordinates. */
export interface PopoverPlacement {
  /** Distance from the viewport's left edge. */
  left: number
  /** Resolved panel width, never wider than the viewport allows. */
  width: number
  /** Which side of the anchor the panel opens on. */
  side: 'above' | 'below'
  /** Distance from the viewport bottom when `side` is `above`, else `null`. */
  bottom: number | null
  /** Distance from the viewport top when `side` is `below`, else `null`. */
  top: number | null
}

/** Clamp `value` into `[min, max]`, tolerating an inverted range. */
function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * Place the popover inside the viewport, next to its anchor.
 *
 * Horizontal placement is the important half: the anchor sits at the left of a
 * full-width sidebar row, so anchoring the panel's *right* edge to it pushed most
 * of a 260px panel past the left edge of the window. Here the panel's left edge
 * is clamped so the whole panel stays visible.
 *
 * @param anchor - the button's viewport rect.
 * @param viewport - current viewport size.
 * @param width - preferred panel width.
 * @param margin - viewport gutter to preserve.
 * @returns fixed coordinates and the chosen side; pure and DOM-free.
 */
export function placePopover(
  anchor: AnchorRect,
  viewport: ViewportSize,
  width: number = POPOVER_WIDTH,
  margin: number = POPOVER_MARGIN,
): PopoverPlacement {
  const resolvedWidth = Math.min(width, Math.max(0, viewport.width - margin * 2))
  const left = clamp(anchor.left, margin, viewport.width - resolvedWidth - margin)

  if (anchor.top - margin >= POPOVER_MIN_ROOM) {
    return {
      left,
      width: resolvedWidth,
      side: 'above',
      bottom: viewport.height - anchor.top + margin,
      top: null,
    }
  }

  return {
    left,
    width: resolvedWidth,
    side: 'below',
    bottom: null,
    top: anchor.bottom + margin,
  }
}
