/**
 * Shared, node-safe wire types for the two halves of `dsh-opencode-go-usage`.
 *
 * The host half produces these values; the browser half consumes them. This
 * module must stay free of any runtime import (types only) so it can be pulled
 * into both the node bundle and the browser bundle without dragging anything in.
 */

/** Whether a quota window still has headroom, or the provider has cut it off. */
export type QuotaWindowStatus = 'ok' | 'rate-limited'

/** One quota window as reported by the provider, normalised for the widget. */
export interface QuotaWindow {
  /** Stable window key from the provider payload (`rolling`, `weekly`, `monthly`, …). */
  id: string
  /** Human-facing short label for the window (for example `5h`, `weekly`). */
  label: string
  /** Provider status; `rate-limited` means the window is exhausted regardless of `percentUsed`. */
  status: QuotaWindowStatus
  /** Fraction of the window already used, in `[0, 1]`. */
  percentUsed: number
  /** ISO-8601 instant at which the window resets. */
  resetsAt: string
  /** True when the window is exhausted (`rate-limited` or 100% used). */
  limitReached: boolean
}

/** A whole-account usage reading. Never contains credential material. */
export interface QuotaSnapshot {
  /** Configured display name of the account/provider. */
  label: string
  /** ISO-8601 instant the snapshot was fetched from the provider. */
  fetchedAt: string
  /** True when the provider fetch failed and this is the last good reading. */
  stale: boolean
  /** True when at least one window is exhausted. */
  limitReached: boolean
  /** `id` of the window with the highest `percentUsed`, or `null` when no window parsed. */
  binding: string | null
  /** Parsed windows, in provider order. */
  windows: QuotaWindow[]
}

/** Why a usage read failed. Never carries a credential value. */
export type UsageFailureReason =
  | 'key-missing'
  | 'key-invalid'
  | 'not-found'
  | 'network'
  | 'parse'
  | 'http'

/** Result envelope returned by the host route and consumed by the widget. */
export type UsageEnvelope =
  | { ok: true; snapshot: QuotaSnapshot }
  | {
      ok: false
      reason: UsageFailureReason
      /** Upstream HTTP status, when the failure came from a response. */
      status?: number
      /** Operator-facing detail. Must never contain credential material. */
      message?: string
    }
