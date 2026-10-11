import { beforeEach, describe, expect, it } from 'vitest'
import { createSnapshotCache, DEFAULT_MIN_REFRESH_MS, type CachedEnvelope, type SnapshotCache } from './cache.js'
import type { UsageEnvelope } from './wire-types.js'

/** A good reading; the fixture timestamp is overridable so staleness is visible. */
function ok(fetchedAt = '2026-10-10T00:00:00.000Z', percent = 50): CachedEnvelope {
  return {
    ok: true,
    snapshot: {
      label: 'OpenCode Go',
      fetchedAt,
      stale: false,
      limitReached: false,
      binding: 'monthly',
      windows: [
        {
          id: 'monthly',
          label: 'Monthly',
          status: 'ok',
          percentUsed: percent / 100,
          resetsAt: '2026-10-23T21:44:23.000Z',
          limitReached: false,
        },
      ],
    },
  }
}

/** A loader that counts how many times it ran. */
function counting(envelope: UsageEnvelope | (() => Promise<UsageEnvelope>)) {
  let calls = 0
  const load = async (): Promise<UsageEnvelope> => {
    calls += 1
    return typeof envelope === 'function' ? envelope() : envelope
  }
  return { calls: () => calls, load }
}

/** A promise plus its resolver, for in-flight tests. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('createSnapshotCache', () => {
  let clock: number
  let now: () => number

  beforeEach(() => {
    clock = 0
    now = () => clock
  })

  function makeCache(options: { ttlMs?: number; minRefreshMs?: number } = {}): SnapshotCache {
    return createSnapshotCache({ ttlMs: options.ttlMs ?? 1000, minRefreshMs: options.minRefreshMs, now })
  }

  it('serves a fresh cached reading without invoking the loader', async () => {
    const cache = makeCache()
    const cachedReading = ok('2026-10-10T00:00:00.000Z', 10)
    cache.set(cachedReading)
    const loader = counting(ok('2026-10-10T01:00:00.000Z', 90))

    const result = await cache.load(loader.load)

    expect(result).toBe(cachedReading)
    expect(loader.calls()).toBe(0)
    expect(cache.get()).toBe(cachedReading)
  })

  it('is fresh strictly within the TTL window', () => {
    const cache = makeCache({ ttlMs: 1000 })
    cache.set(ok())

    clock = 999
    expect(cache.isFresh()).toBe(true)
    expect(cache.ageMs()).toBe(999)

    clock = 1000
    expect(cache.isFresh()).toBe(false)
  })

  it('reports no freshness or age before anything is cached', () => {
    const cache = makeCache()

    expect(cache.isFresh()).toBe(false)
    expect(cache.get()).toBeUndefined()
    expect(cache.ageMs()).toBeUndefined()
  })

  it('invokes the loader once for an expired reading and stores the new one', async () => {
    const cache = makeCache({ ttlMs: 1000 })
    cache.set(ok('2026-10-10T00:00:00.000Z', 10))
    const fresh = ok('2026-10-10T02:00:00.000Z', 20)
    const loader = counting(fresh)

    clock = 1000
    const result = await cache.load(loader.load)

    expect(loader.calls()).toBe(1)
    expect(result).toBe(fresh)
    expect(cache.get()).toBe(fresh)
    expect(cache.isFresh()).toBe(true)
  })

  it('restarts the TTL window on every set', () => {
    const cache = makeCache({ ttlMs: 1000 })
    cache.set(ok())
    clock = 900
    cache.set(ok('2026-10-10T00:01:00.000Z'))

    clock = 1500
    expect(cache.ageMs()).toBe(600)
    expect(cache.isFresh()).toBe(true)
  })

  it('shares one in-flight loader invocation between concurrent callers', async () => {
    const cache = makeCache()
    const gate = deferred<UsageEnvelope>()
    const loader = counting(() => gate.promise)

    const first = cache.load(loader.load)
    const second = cache.load(loader.load)

    expect(loader.calls()).toBe(1)
    expect(second).toBe(first)

    const reading = ok()
    gate.resolve(reading)

    await expect(first).resolves.toBe(reading)
    await expect(second).resolves.toBe(reading)
    expect(loader.calls()).toBe(1)
  })

  it('allows a new load after the in-flight one settled', async () => {
    const cache = makeCache()
    const loader = counting(ok())

    await cache.load(loader.load)
    clock = 1000
    await cache.load(loader.load)

    expect(loader.calls()).toBe(2)
  })

  it('marks a reading stale when a reload fails on the network', async () => {
    const cache = makeCache()
    const good = ok('2026-10-10T00:00:00.000Z', 40)
    cache.set(good)
    clock = 10_000
    const failure: UsageEnvelope = { ok: false, reason: 'network', message: 'provider request failed (network or timeout)' }

    const result = await cache.load(async () => failure)

    expect(result).toEqual({ ok: true, snapshot: { ...good.snapshot, stale: true } })
    if (!result.ok) throw new Error('expected the stale reading to be served')
    expect(result.snapshot.fetchedAt).toBe(good.snapshot.fetchedAt)
    expect(cache.get()?.snapshot.stale).toBe(true)
    // The failed reload must not have refreshed the TTL window.
    expect(cache.isFresh()).toBe(false)
  })

  it('marks a reading stale when a reload cannot be parsed', async () => {
    const cache = makeCache()
    cache.set(ok())
    clock = 10_000

    const result = await cache.load(async () => ({ ok: false, reason: 'parse', message: 'response carried no usable usage windows' }))

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected the stale reading to be served')
    expect(result.snapshot.stale).toBe(true)
  })

  it('expires the TTL when a failed forced refresh serves a stale reading inside the window', async () => {
    const cache = makeCache({ ttlMs: 1000 })
    const good = ok('2026-10-10T00:00:00.000Z', 40)
    cache.set(good)
    clock = 100

    // The previous snapshot is genuinely fresh before the forced attempt.
    expect(cache.isFresh()).toBe(true)

    const failure: UsageEnvelope = { ok: false, reason: 'network', message: 'provider request failed (network or timeout)' }
    const result = await cache.load(async () => failure, { force: true })

    // The stale copy is still what gets served...
    expect(result).toEqual({ ok: true, snapshot: { ...good.snapshot, stale: true } })
    if (!result.ok) throw new Error('expected the stale reading to be served')
    expect(result.snapshot.fetchedAt).toBe(good.snapshot.fetchedAt)
    expect(cache.get()?.snapshot.stale).toBe(true)
    // ...but it must not keep the failed attempt's TTL window alive.
    expect(cache.isFresh()).toBe(false)

    // A later GET therefore retries the provider instead of re-serving it.
    const loader = counting(ok('2026-10-10T05:00:00.000Z', 60))
    const retried = await cache.load(loader.load)
    expect(loader.calls()).toBe(1)
    expect(retried.ok).toBe(true)
    if (!retried.ok) throw new Error('expected the reload to succeed')
    expect(retried.snapshot.stale).toBe(false)
  })

  it('propagates a transport failure when there is no previous reading', async () => {
    const cache = makeCache()
    const failure: UsageEnvelope = { ok: false, reason: 'network', message: 'provider request failed (network or timeout)' }

    const result = await cache.load(async () => failure)

    expect(result).toBe(failure)
    expect(cache.get()).toBeUndefined()
  })

  it('converts a throwing loader into a transport failure without leaking its message', async () => {
    const cache = makeCache()

    const result = await cache.load(async () => {
      throw new Error('Bearer sk-super-secret-value')
    })

    expect(result).toEqual({ ok: false, reason: 'network', message: 'quota load failed' })
    expect(JSON.stringify(result)).not.toContain('sk-super-secret-value')
  })

  it('clears the cache and propagates a missing credential', async () => {
    const cache = makeCache()
    cache.set(ok())
    clock = 10_000
    const failure: UsageEnvelope = { ok: false, reason: 'key-missing', message: 'credential OPENCODE_GO_API_KEY is not set' }

    const result = await cache.load(async () => failure)

    expect(result).toBe(failure)
    expect(cache.get()).toBeUndefined()
    expect(cache.ageMs()).toBeUndefined()
    expect(cache.isFresh()).toBe(false)
  })

  it('clears the cache and propagates an invalid credential', async () => {
    const cache = makeCache()
    cache.set(ok())
    clock = 10_000
    const failure: UsageEnvelope = { ok: false, reason: 'key-invalid', status: 401, message: 'provider rejected the credential (401)' }

    const result = await cache.load(async () => failure)

    expect(result).toBe(failure)
    expect(cache.get()).toBeUndefined()
  })

  it('keeps the last good reading through a not-found or http failure but does not serve it as stale', async () => {
    const cache = makeCache()
    const good = ok()
    cache.set(good)
    clock = 10_000
    const notFound: UsageEnvelope = { ok: false, reason: 'not-found', status: 404, message: 'usage endpoint not found (404)' }

    const first = await cache.load(async () => notFound)
    expect(first).toBe(notFound)
    expect(cache.get()).toBe(good)

    const httpFailure: UsageEnvelope = { ok: false, reason: 'http', status: 500, message: 'provider returned HTTP 500' }
    const second = await cache.load(async () => httpFailure)
    expect(second).toBe(httpFailure)
    expect(cache.get()).toBe(good)
  })

  it('stores a successful load with stale false', async () => {
    const cache = makeCache()
    const reading = ok()

    const result = await cache.load(async () => reading)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a successful load')
    expect(result.snapshot.stale).toBe(false)
    expect(cache.get()?.snapshot.stale).toBe(false)
    expect(cache.isFresh()).toBe(true)
  })

  it('gates forced refreshes behind the default floor', async () => {
    const cache = makeCache()
    const loader = counting(ok())

    expect(cache.canForceRefresh()).toBe(true)
    await cache.load(loader.load)
    expect(cache.canForceRefresh()).toBe(false)

    clock = DEFAULT_MIN_REFRESH_MS - 1
    expect(cache.canForceRefresh()).toBe(false)

    clock = DEFAULT_MIN_REFRESH_MS
    expect(cache.canForceRefresh()).toBe(true)
  })

  it('honours a custom refresh floor', async () => {
    const cache = makeCache({ minRefreshMs: 250 })
    const loader = counting(ok())

    await cache.load(loader.load)
    clock = 249
    expect(cache.canForceRefresh()).toBe(false)
    clock = 250
    expect(cache.canForceRefresh()).toBe(true)
  })

  it('does not start the refresh floor for a manually set reading', () => {
    const cache = makeCache()
    cache.set(ok())

    expect(cache.canForceRefresh()).toBe(true)
  })

  it('bypasses the TTL for a forced load', async () => {
    const cache = makeCache()
    const cachedReading = ok('2026-10-10T00:00:00.000Z', 10)
    cache.set(cachedReading)
    const replacement = ok('2026-10-10T03:00:00.000Z', 90)
    const loader = counting(replacement)

    const unforced = await cache.load(loader.load)
    expect(unforced).toBe(cachedReading)
    expect(loader.calls()).toBe(0)

    const forced = await cache.load(loader.load, { force: true })
    expect(forced).toBe(replacement)
    expect(loader.calls()).toBe(1)
    expect(cache.get()).toBe(replacement)
  })

  it('does not start a second provider call while a forced refresh is in flight', async () => {
    const cache = makeCache()
    cache.set(ok())
    const gate = deferred<UsageEnvelope>()
    const loader = counting(() => gate.promise)

    const first = cache.load(loader.load, { force: true })
    const second = cache.load(loader.load, { force: true })

    expect(loader.calls()).toBe(1)
    expect(second).toBe(first)
    gate.resolve(ok('2026-10-10T04:00:00.000Z'))
    await first
  })

  it('clears the stored reading', async () => {
    const cache = makeCache()
    cache.set(ok())
    expect(cache.get()).toBeDefined()

    cache.clear()

    expect(cache.get()).toBeUndefined()
    expect(cache.ageMs()).toBeUndefined()
    expect(cache.isFresh()).toBe(false)
  })
})
