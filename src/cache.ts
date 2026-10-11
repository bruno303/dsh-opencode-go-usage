/**
 * TTL snapshot cache with single-flight loading and a refresh floor.
 *
 * Three behaviors this module exists to guarantee:
 *
 * 1. **Single-flight** — concurrent callers share one provider request, so a
 *    burst of browser polls never multiplies upstream load.
 * 2. **Stale-on-transport-failure** — when a reload fails for a reason that may
 *    be transient (`network`, `parse`), the last good reading is still served
 *    with `stale: true`, so a blip never blanks the widget.
 * 3. **Fail-closed on credential failure** — `key-missing`/`key-invalid` clears
 *    the cache and propagates the failure instead of serving a reading that the
 *    provider has already refused.
 *
 * The clock is injected so every boundary (TTL edge, refresh floor) is testable
 * without timers, and the module is pure: no I/O, no `node:http`, no Cordis.
 */
import type { UsageEnvelope } from './wire-types.js'

/** The cached shape: only successful readings are ever stored. */
export type CachedEnvelope = Extract<UsageEnvelope, { ok: true }>

/** One loaded envelope; a cache that never stored a success has none. */
export interface SnapshotCache {
  /** The last good reading, or `undefined` when nothing successful is cached. */
  get(): CachedEnvelope | undefined
  /** Whether {@link get} is still inside the TTL window. */
  isFresh(): boolean
  /** Store a good reading and restart its TTL window. */
  set(envelope: CachedEnvelope): void
  /**
   * Drop the stored reading. Does NOT reset the refresh floor: a credential
   * failure that clears the cache must not unlock immediate retry hammering.
   */
  clear(): void
  /** Milliseconds since the stored reading was stored, or `undefined` when empty. */
  ageMs(): number | undefined
  /** Whether the refresh floor has elapsed since the last provider load started. */
  canForceRefresh(): boolean
  /**
   * Serve the cached reading when fresh, otherwise run `loader`.
   * @param loader - provider load; its failure envelope drives the stale/clear rules.
   * @param options - `force: true` bypasses the TTL check.
   */
  load(
    loader: () => Promise<UsageEnvelope>,
    options?: { readonly force?: boolean },
  ): Promise<UsageEnvelope>
}

/** Construction options for {@link createSnapshotCache}. */
export interface SnapshotCacheOptions {
  /** How long a good reading is served before another provider load. */
  ttlMs: number
  /** Anti-spam floor between forced refreshes. @default 5000 */
  minRefreshMs?: number
  /** Clock in epoch milliseconds. @default Date.now */
  now?: () => number
}

/** Default anti-spam floor between forced refreshes (PLAN.md §4). */
export const DEFAULT_MIN_REFRESH_MS = 5000

/**
 * Create a snapshot cache.
 * @param options - TTL, optional refresh floor, optional clock.
 * @returns the cache instance.
 */
export function createSnapshotCache(options: SnapshotCacheOptions): SnapshotCache {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs
  const minRefreshMs = options.minRefreshMs ?? DEFAULT_MIN_REFRESH_MS

  let cached: CachedEnvelope | undefined
  let storedAt: number | undefined
  let lastLoadStartedAt: number | undefined
  let inFlight: Promise<UsageEnvelope> | undefined

  function ageMs(): number | undefined {
    if (cached === undefined || storedAt === undefined) return undefined
    return now() - storedAt
  }

  function isFresh(): boolean {
    const age = ageMs()
    // Strict `<`: a reading is no longer fresh exactly at its TTL boundary.
    return age !== undefined && age < ttlMs
  }

  function canForceRefresh(): boolean {
    if (lastLoadStartedAt === undefined) return true
    return now() - lastLoadStartedAt >= minRefreshMs
  }

  async function runLoad(loader: () => Promise<UsageEnvelope>): Promise<UsageEnvelope> {
    let result: UsageEnvelope
    try {
      result = await loader()
    } catch {
      // A loader that throws is indistinguishable from a transport failure, and
      // its message is not safe to surface.
      result = { ok: false, reason: 'network', message: 'quota load failed' }
    }

    if (result.ok) {
      cached = result
      storedAt = now()
      return result
    }

    if (result.reason === 'network' || result.reason === 'parse') {
      const previous = cached
      if (previous === undefined) return result
      // Keep serving the last good reading, marked stale. Its TTL window is
      // expired explicitly rather than left alone: a *forced* refresh that
      // fails inside the previous snapshot's TTL would otherwise leave
      // `isFresh()` true and every later GET would keep re-serving the stale
      // copy until the original TTL ran out. Backdating the stored timestamp
      // makes the next unforced load retry the provider immediately while the
      // stale snapshot stays readable.
      const stale: CachedEnvelope = { ok: true, snapshot: { ...previous.snapshot, stale: true } }
      cached = stale
      storedAt = now() - ttlMs
      return stale
    }

    if (result.reason === 'key-missing' || result.reason === 'key-invalid') {
      // The provider has refused this credential: the cached reading is for a
      // key that no longer applies. Drop it rather than show a stale copy.
      cached = undefined
      storedAt = undefined
      return result
    }

    // `not-found` and `http`: a configuration/upstream problem. Propagate the
    // failure but keep the last good reading so a later network failure can
    // still serve it as stale.
    return result
  }

  return {
    get: () => cached,
    isFresh,
    set: (envelope) => {
      cached = envelope
      storedAt = now()
    },
    clear: () => {
      cached = undefined
      storedAt = undefined
    },
    ageMs,
    canForceRefresh,
    load: (loader, loadOptions) => {
      const force = loadOptions?.force === true
      if (!force && isFresh() && cached !== undefined) return Promise.resolve(cached)
      if (inFlight !== undefined) return inFlight

      lastLoadStartedAt = now()
      const pending = runLoad(loader)
      inFlight = pending
      const settle = (): void => {
        // Identity-checked so a later load's in-flight promise is never cleared
        // by an earlier one settling late.
        if (inFlight === pending) inFlight = undefined
      }
      pending.then(settle, settle)
      return pending
    },
  }
}
