import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { PeerAdmission, PeerScope } from '@deepseek-ai/dsh-client-connection'
import packageJson from '../package.json' with { type: 'json' }
// The browser half's constant for the header this module writes. It is imported
// (not duplicated) so the two halves can never disagree about the header name:
// `usage-view.test.ts` pins the same literal from the client side.
import { SNAPSHOT_AGE_HEADER } from './client/usage-view.js'
import { createSnapshotCache, type CachedEnvelope } from './cache.js'
import { fetchQuota, USER_AGENT } from './quota-provider.js'
import { createUsageHandler, REFRESH_ROUTE, USAGE_ROUTE, type UsageHandlerDeps } from './route.js'
import type { UsageEnvelope } from './wire-types.js'

/** A valid provider body (the verified live shape). */
const QUOTA_BODY = {
  usage: {
    rolling: { status: 'ok', percent: 1, resetsAt: '2026-10-11T01:21:36.000Z' },
    weekly: { status: 'ok', percent: 19, resetsAt: '2026-10-12T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 30, resetsAt: '2026-10-23T21:44:23.000Z' },
  },
}

const ENDPOINT = 'https://opencode.test/zen/go/v1/usage'

/** A successful envelope for cache seeding and route expectations. */
function okEnvelope(fetchedAt = '2026-10-10T00:00:00.000Z', tag = 'seeded'): CachedEnvelope {
  return {
    ok: true,
    snapshot: {
      label: tag,
      fetchedAt,
      stale: false,
      limitReached: false,
      binding: 'monthly',
      windows: [
        {
          id: 'monthly',
          label: 'Monthly',
          status: 'ok',
          percentUsed: 0.3,
          resetsAt: '2026-10-23T21:44:23.000Z',
          limitReached: false,
        },
      ],
    },
  }
}

/** A counting provider loader for handler tests. */
function spyLoader(produce: () => UsageEnvelope | Promise<UsageEnvelope>) {
  let calls = 0
  return {
    calls: () => calls,
    loadEnvelope: async (): Promise<UsageEnvelope> => {
      calls += 1
      return produce()
    },
  }
}

/** The admitted arm of an admission; the handler only tests that it is not a refusal. */
const ADMITTED: PeerAdmission = { peer: {} as PeerScope }

/** A minimal node request stand-in; only method, url, and headers are read. */
function fakeRequest(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage
}

/** A response stand-in that captures status, headers, and body. */
function fakeResponse(): { res: ServerResponse; captured: { status: number; headers: Record<string, string>; body: string } } {
  const captured = { status: 0, headers: {} as Record<string, string>, body: '' }
  const res = {
    get headersSent(): boolean {
      return captured.status !== 0
    },
    writeHead(status: number, headers?: Record<string, string | number>): unknown {
      captured.status = status
      for (const [key, value] of Object.entries(headers ?? {})) captured.headers[key] = String(value)
      return res
    },
    end(body?: string): void {
      captured.body = body ?? ''
    },
  }
  return { res: res as unknown as ServerResponse, captured }
}

/** Drive the handler once and capture its response. */
async function call(
  deps: UsageHandlerDeps,
  method: string,
  url: string,
): Promise<{ status: number; headers: Record<string, string>; body: string; json: unknown }> {
  const { res, captured } = fakeResponse()
  await createUsageHandler(deps)(fakeRequest(method, url), res)
  return {
    status: captured.status,
    headers: captured.headers,
    body: captured.body,
    json: captured.body === '' ? undefined : JSON.parse(captured.body),
  }
}

describe('fetchQuota', () => {
  it('sends a Bearer request with the documented headers and a deadline signal', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify(QUOTA_BODY), { status: 200 })
    }

    const envelope = await fetchQuota({
      url: ENDPOINT,
      apiKey: 'sk-test-key',
      timeoutMs: 50,
      label: 'OpenCode Go',
      fetchImpl,
      now: () => Date.UTC(2026, 9, 10, 12, 0, 0),
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(ENDPOINT)
    expect(seen[0]?.init.method).toBe('GET')
    const headers = seen[0]?.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test-key')
    expect(headers.Accept).toBe('application/json')
    expect(headers['User-Agent']).toBe(`dsh-opencode-go-usage/${packageJson.version}`)
    expect(USER_AGENT).toBe(`dsh-opencode-go-usage/${packageJson.version}`)
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal)

    expect(envelope).toEqual({
      ok: true,
      snapshot: {
        label: 'OpenCode Go',
        fetchedAt: '2026-10-10T12:00:00.000Z',
        stale: false,
        limitReached: false,
        binding: 'monthly',
        windows: [
          {
            id: 'rolling',
            label: '5h',
            status: 'ok',
            percentUsed: 0.01,
            resetsAt: '2026-10-11T01:21:36.000Z',
            limitReached: false,
          },
          {
            id: 'weekly',
            label: 'Weekly',
            status: 'ok',
            percentUsed: 0.19,
            resetsAt: '2026-10-12T00:00:00.000Z',
            limitReached: false,
          },
          {
            id: 'monthly',
            label: 'Monthly',
            status: 'ok',
            percentUsed: 0.3,
            resetsAt: '2026-10-23T21:44:23.000Z',
            limitReached: false,
          },
        ],
      },
    })
  })

  it('maps 401 and 403 to key-invalid', async () => {
    for (const status of [401, 403]) {
      const fetchImpl: typeof fetch = async () => new Response('denied', { status })
      const envelope = await fetchQuota({
        url: ENDPOINT,
        apiKey: 'sk-test-key',
        timeoutMs: 50,
        label: 'OpenCode Go',
        fetchImpl,
      })

      expect(envelope).toEqual({
        ok: false,
        reason: 'key-invalid',
        status,
        message: `provider rejected the credential (${status})`,
      })
    }
  })

  it('maps 404 to not-found naming the usageUrl field', async () => {
    const fetchImpl: typeof fetch = async () => new Response('gone', { status: 404 })

    const envelope = await fetchQuota({
      url: ENDPOINT,
      apiKey: 'sk-test-key',
      timeoutMs: 50,
      label: 'OpenCode Go',
      fetchImpl,
    })

    expect(envelope).toEqual({
      ok: false,
      reason: 'not-found',
      status: 404,
      message: 'usage endpoint not found (404); check the configured usageUrl',
    })
  })

  it('maps any other non-2xx status to http with the status code', async () => {
    const fetchImpl: typeof fetch = async () => new Response('boom', { status: 500 })

    const envelope = await fetchQuota({
      url: ENDPOINT,
      apiKey: 'sk-test-key',
      timeoutMs: 50,
      label: 'OpenCode Go',
      fetchImpl,
    })

    expect(envelope).toEqual({
      ok: false,
      reason: 'http',
      status: 500,
      message: 'provider returned HTTP 500',
    })
  })

  it('maps an unparseable JSON body to parse', async () => {
    const fetchImpl: typeof fetch = async () => new Response('<html>not json</html>', { status: 200 })

    const envelope = await fetchQuota({
      url: ENDPOINT,
      apiKey: 'sk-test-key',
      timeoutMs: 50,
      label: 'OpenCode Go',
      fetchImpl,
    })

    expect(envelope).toEqual({ ok: false, reason: 'parse', message: 'provider returned a non-JSON body' })
  })

  it('maps a JSON body without usable windows to parse', async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ usage: { rolling: { status: 'paused' } } }), { status: 200 })

    const envelope = await fetchQuota({
      url: ENDPOINT,
      apiKey: 'sk-test-key',
      timeoutMs: 50,
      label: 'OpenCode Go',
      fetchImpl,
    })

    expect(envelope).toEqual({
      ok: false,
      reason: 'parse',
      message: 'response carried no usable usage windows',
    })
  })

  it('maps a transport rejection and an abort to network', async () => {
    const rejects: typeof fetch = async () => {
      throw new Error(`connect ECONNREFUSED for ${ENDPOINT}`)
    }
    const aborts: typeof fetch = async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    }

    for (const fetchImpl of [rejects, aborts]) {
      const envelope = await fetchQuota({
        url: ENDPOINT,
        apiKey: 'sk-test-key',
        timeoutMs: 50,
        label: 'OpenCode Go',
        fetchImpl,
      })

      expect(envelope).toEqual({
        ok: false,
        reason: 'network',
        message: 'provider request failed (network or timeout)',
      })
    }
  })

  it('carries rate-limited and limitReached through to the snapshot', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          usage: {
            rolling: { status: 'rate-limited', percent: 2, resetsAt: '2026-10-11T01:21:36.000Z' },
            monthly: { status: 'ok', percent: 100, resetsAt: '2026-10-23T21:44:23.000Z' },
          },
        }),
        { status: 200 },
      )

    const envelope = await fetchQuota({
      url: ENDPOINT,
      apiKey: 'sk-test-key',
      timeoutMs: 50,
      label: 'OpenCode Go',
      fetchImpl,
    })

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) throw new Error('expected a successful read')
    expect(envelope.snapshot.limitReached).toBe(true)
    expect(envelope.snapshot.binding).toBe('rolling')
    expect(envelope.snapshot.windows.map((entry) => entry.percentUsed)).toEqual([1, 1])
  })
})

describe('createUsageHandler', () => {
  function baseDeps(overrides: Partial<UsageHandlerDeps> = {}): UsageHandlerDeps {
    return {
      cache: createSnapshotCache({ ttlMs: 60_000, now: () => 0 }),
      loadEnvelope: spyLoader(() => okEnvelope()).loadEnvelope,
      admit: () => ADMITTED,
      ...overrides,
    }
  }

  it('passes a 401 refusal through without touching the cache or the provider', async () => {
    const loader = spyLoader(() => okEnvelope())
    const cache = createSnapshotCache({ ttlMs: 60_000, now: () => 0 })

    const response = await call(
      { cache, loadEnvelope: loader.loadEnvelope, admit: () => ({ rejection: 401 }) },
      'GET',
      USAGE_ROUTE,
    )

    expect(response.status).toBe(401)
    expect(response.json).toEqual({ ok: false, reason: 'http', status: 401 })
    expect(loader.calls()).toBe(0)
    expect(cache.get()).toBeUndefined()
  })

  it('passes a 403 refusal through on the refresh route as well', async () => {
    const loader = spyLoader(() => okEnvelope())

    const response = await call(
      {
        cache: createSnapshotCache({ ttlMs: 60_000, now: () => 0 }),
        loadEnvelope: loader.loadEnvelope,
        admit: () => ({ rejection: 403 }),
      },
      'POST',
      REFRESH_ROUTE,
    )

    expect(response.status).toBe(403)
    expect(response.json).toEqual({ ok: false, reason: 'http', status: 403 })
    expect(loader.calls()).toBe(0)
  })

  it('answers a fixed, secret-free 500 when admission itself throws', async () => {
    // A throwing `admit` is an unexpected internal failure, not a refusal. The
    // handler must swallow the exception entirely: an escaping throw would
    // carry its message (here, a credential-shaped token) into the framework's
    // error path, and echoing the message back would paint it into the widget.
    const SECRET = 'sk-FAKE-SECRET-VALUE'
    const THROWN = `admission failed while checking credential ${SECRET}`
    const FIXED_BODY = '{"ok":false,"reason":"http","status":500,"message":"internal error"}'

    const routes: ReadonlyArray<readonly [string, string]> = [
      ['GET', USAGE_ROUTE],
      ['POST', REFRESH_ROUTE],
    ]

    for (const [method, url] of routes) {
      const loader = spyLoader(() => okEnvelope())
      const cache = createSnapshotCache({ ttlMs: 60_000, now: () => 0 })

      const response = await call(
        {
          cache,
          loadEnvelope: loader.loadEnvelope,
          admit: () => {
            throw new Error(THROWN)
          },
        },
        method,
        url,
      )

      expect(response.status).toBe(500)
      // Byte-for-byte the module's fixed body: no interpolation is possible.
      expect(response.body).toBe(FIXED_BODY)
      expect(response.json).toEqual({ ok: false, reason: 'http', status: 500, message: 'internal error' })
      // Neither the fake token nor any fragment of the thrown message leaks
      // through the body or through any response header value.
      expect(response.body).not.toContain(SECRET)
      expect(response.body).not.toContain('admission failed')
      expect(response.body).not.toContain('FAKE-SECRET')
      const headerText = Object.entries(response.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n')
      expect(headerText).not.toContain(SECRET)
      expect(headerText).not.toContain('admission failed')
      // The throw happens before dispatch, so nothing reached the provider or
      // the cache on either route.
      expect(loader.calls()).toBe(0)
      expect(cache.get()).toBeUndefined()
    }
  })

  it('serves a fresh cached reading on GET without loading', async () => {
    const loader = spyLoader(() => okEnvelope('2026-10-10T09:00:00.000Z', 'loaded'))
    const cache = createSnapshotCache({ ttlMs: 60_000, now: () => 0 })
    const seeded = okEnvelope('2026-10-10T00:00:00.000Z', 'seeded')
    cache.set(seeded)

    const response = await call({ cache, loadEnvelope: loader.loadEnvelope, admit: () => ADMITTED }, 'GET', USAGE_ROUTE)

    expect(response.status).toBe(200)
    expect(response.json).toEqual(seeded)
    expect(loader.calls()).toBe(0)
  })

  it('loads once on a GET miss and then serves the loaded reading from cache', async () => {
    let clock = 0
    const loader = spyLoader(() => okEnvelope('2026-10-10T00:00:01.000Z', 'loaded'))
    const cache = createSnapshotCache({ ttlMs: 60_000, now: () => clock })
    const deps: UsageHandlerDeps = { cache, loadEnvelope: loader.loadEnvelope, admit: () => ADMITTED }

    const first = await call(deps, 'GET', USAGE_ROUTE)
    expect(first.status).toBe(200)
    expect(first.json).toMatchObject({ ok: true, snapshot: { label: 'loaded' } })
    expect(loader.calls()).toBe(1)

    clock = 1000
    const second = await call(deps, 'GET', USAGE_ROUTE)
    expect(second.json).toEqual(first.json)
    expect(loader.calls()).toBe(1)
  })

  it('reloads on GET once the cached reading expired', async () => {
    let clock = 0
    const loader = spyLoader(() => okEnvelope('2026-10-10T00:00:05.000Z', 'reloaded'))
    const cache = createSnapshotCache({ ttlMs: 1000, now: () => clock })
    cache.set(okEnvelope('2026-10-10T00:00:00.000Z', 'old'))
    const deps: UsageHandlerDeps = { cache, loadEnvelope: loader.loadEnvelope, admit: () => ADMITTED }

    clock = 1001
    const response = await call(deps, 'GET', USAGE_ROUTE)

    expect(loader.calls()).toBe(1)
    expect(response.json).toMatchObject({ ok: true, snapshot: { label: 'reloaded' } })
  })

  it('serves the current reading on a refresh inside the floor without calling the provider', async () => {
    let clock = 0
    const first = okEnvelope('2026-10-10T00:00:00.000Z', 'first')
    let produced: UsageEnvelope = first
    const loader = spyLoader(() => produced)
    const cache = createSnapshotCache({ ttlMs: 60_000, now: () => clock })
    // A real load starts the refresh floor.
    await cache.load(loader.loadEnvelope)
    expect(loader.calls()).toBe(1)
    produced = okEnvelope('2026-10-10T00:10:00.000Z', 'second')

    clock = 1000
    const response = await call({ cache, loadEnvelope: loader.loadEnvelope, admit: () => ADMITTED }, 'POST', REFRESH_ROUTE)

    expect(response.status).toBe(200)
    expect(response.json).toEqual(first)
    expect(loader.calls()).toBe(1)
  })

  it('forces a reload on a refresh after the floor elapses', async () => {
    let clock = 0
    let produced: UsageEnvelope = okEnvelope('2026-10-10T00:00:00.000Z', 'first')
    const loader = spyLoader(() => produced)
    const cache = createSnapshotCache({ ttlMs: 60_000, now: () => clock })
    await cache.load(loader.loadEnvelope)
    produced = okEnvelope('2026-10-10T00:10:00.000Z', 'second')

    clock = 5000
    const response = await call({ cache, loadEnvelope: loader.loadEnvelope, admit: () => ADMITTED }, 'POST', REFRESH_ROUTE)

    expect(loader.calls()).toBe(2)
    expect(response.json).toMatchObject({ ok: true, snapshot: { label: 'second' } })
  })

  it('reports a throttled refresh when no reading is available yet', async () => {
    let clock = 0
    const loader = spyLoader(() => okEnvelope())
    const cache = createSnapshotCache({ ttlMs: 60_000, now: () => clock })
    // A failed first load starts the floor but stores nothing.
    await cache.load(async () => ({ ok: false, reason: 'network', message: 'provider request failed (network or timeout)' }))

    clock = 1000
    const response = await call({ cache, loadEnvelope: loader.loadEnvelope, admit: () => ADMITTED }, 'POST', REFRESH_ROUTE)

    expect(response.status).toBe(200)
    expect(response.json).toEqual({ ok: false, reason: 'http', message: 'refresh is throttled; no reading is available yet' })
    expect(loader.calls()).toBe(0)
  })

  it('answers 405 with an Allow header and never calls the provider', async () => {
    const loader = spyLoader(() => okEnvelope())
    const cache = createSnapshotCache({ ttlMs: 60_000, now: () => 0 })
    const deps: UsageHandlerDeps = { cache, loadEnvelope: loader.loadEnvelope, admit: () => ADMITTED }

    const postUsage = await call(deps, 'POST', USAGE_ROUTE)
    expect(postUsage.status).toBe(405)
    expect(postUsage.headers.Allow).toBe('GET')
    expect(postUsage.json).toEqual({ ok: false, reason: 'http', status: 405, message: 'method not allowed' })

    const getRefresh = await call(deps, 'GET', REFRESH_ROUTE)
    expect(getRefresh.status).toBe(405)
    expect(getRefresh.headers.Allow).toBe('POST')

    const deleteUsage = await call(deps, 'DELETE', USAGE_ROUTE)
    expect(deleteUsage.status).toBe(405)
    expect(deleteUsage.headers.Allow).toBe('GET')

    expect(loader.calls()).toBe(0)
  })

  it('answers 404 on an unknown path', async () => {
    const response = await call(baseDeps(), 'GET', '/__dsh_opencode_go_usage__/nope')

    expect(response.status).toBe(404)
    expect(response.json).toEqual({ ok: false, reason: 'http', status: 404, message: 'unknown route' })
  })

  it('writes JSON with an explicit Content-Length and no-store', async () => {
    const cache = createSnapshotCache({ ttlMs: 60_000, now: () => 0 })
    cache.set(okEnvelope())

    const response = await call(baseDeps({ cache }), 'GET', USAGE_ROUTE)

    expect(response.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(response.headers['Content-Length']).toBe(String(Buffer.byteLength(response.body, 'utf8')))
    expect(Number(response.headers['Content-Length'])).toBe(Buffer.byteLength(response.body, 'utf8'))
    expect(response.headers['Cache-Control']).toBe('no-store')
  })

  it('reports the served snapshot age from the injected clock', async () => {
    const fetchedAt = '2026-10-10T00:00:00.000Z'
    const cache = createSnapshotCache({ ttlMs: 60_000, now: () => 0 })
    cache.set(okEnvelope(fetchedAt))

    const response = await call(
      baseDeps({ cache, now: () => Date.parse(fetchedAt) + 250 }),
      'GET',
      USAGE_ROUTE,
    )

    // The browser half consumes this exact header (clock-skew-proof "updated …
    // ago"), so it is pinned through the client's own constant as well as the
    // wire literal.
    expect(SNAPSHOT_AGE_HEADER).toBe('X-Usage-Snapshot-Age-Ms')
    expect(response.headers['X-Usage-Snapshot-Age-Ms']).toBe('250')
    expect(response.headers[SNAPSHOT_AGE_HEADER]).toBe('250')
  })

  it('reports the age on a refresh response too, and clamps a future fetchedAt to zero', async () => {
    const futureStamp = '2026-10-10T00:00:20.000Z'
    const loader = spyLoader(() => okEnvelope(futureStamp, 'future'))

    // The freshly loaded snapshot claims to be newer than the host clock; the
    // header must never go negative.
    const response = await call(
      {
        cache: createSnapshotCache({ ttlMs: 60_000, now: () => 0 }),
        loadEnvelope: loader.loadEnvelope,
        admit: () => ADMITTED,
        now: () => Date.parse('2026-10-10T00:00:10.000Z'),
      },
      'POST',
      REFRESH_ROUTE,
    )

    expect(response.status).toBe(200)
    expect(response.json).toMatchObject({ ok: true, snapshot: { label: 'future' } })
    expect(response.headers[SNAPSHOT_AGE_HEADER]).toBe('0')
  })

  it('omits the age header when the snapshot timestamp cannot be parsed', async () => {
    const cache = createSnapshotCache({ ttlMs: 60_000, now: () => 0 })
    cache.set(okEnvelope('not a date'))

    const response = await call(baseDeps({ cache, now: () => 0 }), 'GET', USAGE_ROUTE)

    expect(response.status).toBe(200)
    // `route.ts`'s `ageHeader` returns {} for an unparseable `fetchedAt`, so the
    // client falls back to its own clock rather than reading a bogus age.
    expect(response.headers[SNAPSHOT_AGE_HEADER]).toBeUndefined()
  })

  it('never lets the credential or the raw upstream body appear in any response', async () => {
    const FAKE_KEY = 'sk-opencode-go-SUPERSECRET-abcdef0123456789'
    const RAW_MARKER = 'RAW-UPSTREAM-BODY-MARKER'
    const bodies: string[] = []
    const authorizations: string[] = []

    const scenarios: Array<{ status: number; body: string }> = [
      // A 200 whose shape drifted: the parser message must stay generic.
      { status: 200, body: JSON.stringify({ usage: { rolling: { status: 'ok' } }, echo: RAW_MARKER, key: FAKE_KEY }) },
      // Refusals whose bodies deliberately echo the credential.
      { status: 401, body: JSON.stringify({ error: RAW_MARKER, key: FAKE_KEY }) },
      { status: 500, body: JSON.stringify({ error: RAW_MARKER, key: FAKE_KEY }) },
    ]

    for (const scenario of scenarios) {
      const fetchImpl: typeof fetch = async (_url, init) => {
        const headers = new Headers(init?.headers)
        authorizations.push(headers.get('authorization') ?? '')
        return new Response(scenario.body, { status: scenario.status })
      }
      const loadEnvelope = (): Promise<UsageEnvelope> =>
        fetchQuota({ url: ENDPOINT, apiKey: FAKE_KEY, timeoutMs: 50, label: 'OpenCode Go', fetchImpl })

      const response = await call(
        {
          cache: createSnapshotCache({ ttlMs: 60_000, now: () => 0 }),
          loadEnvelope,
          admit: () => ADMITTED,
        },
        'GET',
        USAGE_ROUTE,
      )
      bodies.push(response.body)
    }

    // Also scan the responses that never reach the provider.
    bodies.push((await call({ ...baseDeps(), admit: () => ({ rejection: 401 }) }, 'GET', USAGE_ROUTE)).body)
    bodies.push((await call(baseDeps(), 'POST', USAGE_ROUTE)).body)
    bodies.push((await call(baseDeps(), 'GET', '/__dsh_opencode_go_usage__/nope')).body)

    // The key really was exercised over the wire.
    expect(authorizations).toEqual([`Bearer ${FAKE_KEY}`, `Bearer ${FAKE_KEY}`, `Bearer ${FAKE_KEY}`])

    for (const body of bodies) {
      expect(body).not.toContain(FAKE_KEY)
      expect(body).not.toContain(RAW_MARKER)
      expect(body).not.toContain('Bearer')
      expect(body).not.toContain('SUPERSECRET')
    }
  })
})
