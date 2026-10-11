import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PeerAdmission, PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { apply, Config, createEnvelopeLoader, inject, name } from './index.js'
import { fetchQuota, type FetchQuotaDeps } from './quota-provider.js'
import { REFRESH_ROUTE, USAGE_ROUTE } from './route.js'
import type { UsageEnvelope } from './wire-types.js'

/** The verified provider body (shapes only; no credential material). */
const QUOTA_BODY = {
  usage: {
    rolling: { status: 'ok', percent: 1, resetsAt: '2026-10-11T01:21:36.000Z' },
    weekly: { status: 'ok', percent: 19, resetsAt: '2026-10-12T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 30, resetsAt: '2026-10-23T21:44:23.000Z' },
  },
}

const ENDPOINT = 'https://opencode.test/zen/go/v1/usage'
/** A credentials-file path fragment the loader must accept as-is. */
const REF_NAME = 'OPENCODE_GO_API_KEY'
/** A fake credential value. It must never appear in an envelope or a response. */
const FAKE_KEY = 'sk-fake-not-a-real-secret-0123456789'
const FETCHED_AT = Date.parse('2026-10-10T12:00:00.000Z')

/** The admitted arm of an admission; the handler only tests that it is not a refusal. */
const ADMITTED: PeerAdmission = { peer: {} as PeerScope }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('plugin shape', () => {
  it('keeps the exported name, inject list, apply, and Config surface', () => {
    expect(name).toBe('dsh-opencode-go-usage')
    expect(inject).toEqual(['webServer', 'credentials', 'connection'])
    expect(typeof apply).toBe('function')

    // The schema IS the settings form; every field needs a working default.
    const defaults = Config(undefined)
    expect(defaults).toEqual({
      apiKeyEnv: REF_NAME,
      usageUrl: 'https://opencode.ai/zen/go/v1/usage',
      displayName: 'OpenCode Go',
      refreshSeconds: 60,
      timeoutMs: 10_000,
    })
  })

  it('lets the operator override the documented fields', () => {
    const config = Config({ apiKeyEnv: 'MY_KEY', usageUrl: ENDPOINT, displayName: 'Go', refreshSeconds: 5, timeoutMs: 250 })

    expect(config).toEqual({ apiKeyEnv: 'MY_KEY', usageUrl: ENDPOINT, displayName: 'Go', refreshSeconds: 5, timeoutMs: 250 })
  })
})

describe('createEnvelopeLoader', () => {
  /** A loader with a recording provider-fetch that runs the real `fetchQuota`. */
  function harness(options: {
    resolve: (ref: CredentialRef) => Promise<ResolvedCredential | undefined>
    providerFetch: typeof fetch
    overrides?: Partial<{ apiKeyEnv: string; usageUrl: string; displayName: string; timeoutMs: number }>
  }) {
    const providerCalls: FetchQuotaDeps[] = []
    const resolveCalls: CredentialRef[] = []
    const loadEnvelope = createEnvelopeLoader(
      {
        apiKeyEnv: REF_NAME,
        usageUrl: ENDPOINT,
        displayName: 'OpenCode Go',
        timeoutMs: 4321,
        ...options.overrides,
      },
      {
        resolveCredential: async (ref) => {
          resolveCalls.push(ref)
          return options.resolve(ref)
        },
        fetchQuotaImpl: async (deps) => {
          providerCalls.push(deps)
          return fetchQuota({ ...deps, fetchImpl: options.providerFetch })
        },
        now: () => FETCHED_AT,
      },
    )
    return { loadEnvelope, providerCalls, resolveCalls }
  }

  it('reports key-missing for a name outside the reference grammar without resolving or fetching', async () => {
    const providerFetch = vi.fn<typeof fetch>()
    const { loadEnvelope, providerCalls, resolveCalls } = harness({
      // A pasted credential value is not a reference name: it must read as
      // "unset", never as a reference to resolve, and must not be echoed back.
      overrides: { apiKeyEnv: `Bearer ${FAKE_KEY}` },
      resolve: async () => ({ value: FAKE_KEY, source: 'file' }),
      providerFetch,
    })

    const envelope = await loadEnvelope()

    expect(envelope).toEqual({
      ok: false,
      reason: 'key-missing',
      message: 'the configured apiKeyEnv is not a valid credential reference name',
    })
    expect(resolveCalls).toEqual([])
    expect(providerCalls).toEqual([])
    expect(providerFetch).not.toHaveBeenCalled()
    // The rejected name is the operator's own input here, so the sanitised
    // message must not contain the pasted value either.
    expect(JSON.stringify(envelope)).not.toContain(FAKE_KEY)
  })

  it('reports key-missing and performs no fetch when the reference resolves to nothing', async () => {
    const providerFetch = vi.fn<typeof fetch>()
    const { loadEnvelope, providerCalls, resolveCalls } = harness({
      resolve: async () => undefined,
      providerFetch,
    })

    const envelope = await loadEnvelope()

    expect(envelope).toEqual({
      ok: false,
      reason: 'key-missing',
      message: `credential ${REF_NAME} is not set`,
    })
    expect(resolveCalls).toEqual([credentialRef(REF_NAME)])
    expect(providerCalls).toEqual([])
    expect(providerFetch).not.toHaveBeenCalled()
  })

  it('resolves a present reference and fetches with the configured url, deadline and label', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = []
    const providerFetch = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init })
      return new Response(JSON.stringify(QUOTA_BODY), { status: 200 })
    }) as typeof fetch

    const { loadEnvelope, providerCalls, resolveCalls } = harness({
      resolve: async () => ({ value: FAKE_KEY, source: 'file' }),
      providerFetch,
    })

    const envelope = await loadEnvelope()

    expect(resolveCalls).toEqual([credentialRef(REF_NAME)])
    // The provider read received exactly the configured transport values.
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0]?.url).toBe(ENDPOINT)
    expect(providerCalls[0]?.timeoutMs).toBe(4321)
    expect(providerCalls[0]?.label).toBe('OpenCode Go')
    expect(providerCalls[0]?.apiKey).toBe(FAKE_KEY)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(ENDPOINT)
    const headers = new Headers(seen[0]?.init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${FAKE_KEY}`)
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal)

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) throw new Error('expected a successful read')
    expect(envelope.snapshot.fetchedAt).toBe(new Date(FETCHED_AT).toISOString())
    expect(envelope.snapshot.windows.map((window) => window.id)).toEqual(['rolling', 'weekly', 'monthly'])

    // The envelope carries quota facts only — never the credential value or the
    // Authorization header it travelled in.
    const serialised = JSON.stringify(envelope)
    expect(serialised).not.toContain(FAKE_KEY)
    expect(serialised).not.toContain('Bearer')
  })

  it('re-resolves the reference on every call so a rotated value is picked up', async () => {
    const values = ['sk-first-000000000000', 'sk-second-00000000000']
    const authorizations: string[] = []
    const providerFetch = (async (_url: unknown, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response(JSON.stringify(QUOTA_BODY), { status: 200 })
    }) as typeof fetch

    let call = 0
    const { loadEnvelope, resolveCalls } = harness({
      resolve: async () => ({ value: values[call++] ?? '', source: 'file' }),
      providerFetch,
    })

    await loadEnvelope()
    await loadEnvelope()

    expect(resolveCalls).toHaveLength(2)
    expect(authorizations[0]).toBe(`Bearer ${values[0]}`)
    expect(authorizations[1]).toBe(`Bearer ${values[1]}`)
  })
})

describe('apply', () => {
  /** A Cordis-context stand-in: only the four seams `apply` touches. */
  function fakeContext(options: { resolve?: () => Promise<ResolvedCredential | undefined>; throwOnRegister?: string } = {}) {
    const routes: WebRoute[] = []
    const effects: Array<{ label: string | undefined; dispose: () => void }> = []
    const resolveCalls: CredentialRef[] = []

    const ctx = {
      credentials: {
        resolve: async (ref: CredentialRef): Promise<ResolvedCredential | undefined> => {
          resolveCalls.push(ref)
          return options.resolve === undefined ? undefined : options.resolve()
        },
      },
      connection: { admit: (): PeerAdmission => ADMITTED },
      webServer: {
        register(route: WebRoute): () => void {
          if (route.path === options.throwOnRegister) throw new Error(`duplicate route: ${route.path}`)
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index !== -1) routes.splice(index, 1)
          }
        },
      },
      effect(execute: () => unknown, label?: string) {
        const disposer = execute()
        const record = {
          label,
          dispose: () => {
            if (typeof disposer === 'function') (disposer as () => void)()
          },
        }
        effects.push(record)
        return () => {
          record.dispose()
        }
      },
    }

    return { ctx: ctx as unknown as Context, routes, effects, resolveCalls }
  }

  /** A node request stand-in; only method, url, and headers are read. */
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

  it('registers both exact routes under one labelled effect and removes them on disposal', async () => {
    const { ctx, routes, effects } = fakeContext()

    await apply(ctx, { usageUrl: ENDPOINT, apiKeyEnv: REF_NAME })

    expect(routes.map((route) => [route.kind, route.path]).sort()).toEqual(
      [
        ['exact', REFRESH_ROUTE],
        ['exact', USAGE_ROUTE],
      ].sort(),
    )
    for (const route of routes) expect(typeof route.handler).toBe('function')

    expect(effects).toHaveLength(1)
    expect(effects[0]?.label).toBe('dsh-opencode-go-usage quota routes')

    effects[0]?.dispose()
    expect(routes).toEqual([])
  })

  it('does not leave the first route mounted when the second registration collides', async () => {
    const { ctx, routes } = fakeContext({ throwOnRegister: REFRESH_ROUTE })

    await expect(apply(ctx, {})).rejects.toThrow(/duplicate route/)

    // The usage route was registered first and must have been rolled back.
    expect(routes).toEqual([])
  })

  it('serves key-missing through the real route without touching the provider when the credential is absent', async () => {
    const providerFetch = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', providerFetch)
    const { ctx, routes, resolveCalls } = fakeContext()
    await apply(ctx, { usageUrl: ENDPOINT, apiKeyEnv: REF_NAME })

    const usageRoute = routes.find((route) => route.path === USAGE_ROUTE)
    if (usageRoute === undefined) throw new Error('usage route not registered')

    const { res, captured } = fakeResponse()
    await usageRoute.handler(fakeRequest('GET', USAGE_ROUTE), res)

    expect(resolveCalls).toEqual([credentialRef(REF_NAME)])
    expect(providerFetch).not.toHaveBeenCalled()
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toEqual({
      ok: false,
      reason: 'key-missing',
      message: `credential ${REF_NAME} is not set`,
    })
  })

  it('fetches through the real route with the configured url and never leaks the credential', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = []
    const providerFetch = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init })
      return new Response(JSON.stringify(QUOTA_BODY), { status: 200 })
    }) as typeof fetch
    vi.stubGlobal('fetch', providerFetch)

    const { ctx, routes } = fakeContext({ resolve: async () => ({ value: FAKE_KEY, source: 'file' }) })
    await apply(ctx, { usageUrl: ENDPOINT, apiKeyEnv: REF_NAME, displayName: 'Go quota', timeoutMs: 1500 })

    const usageRoute = routes.find((route) => route.path === USAGE_ROUTE)
    if (usageRoute === undefined) throw new Error('usage route not registered')

    const { res, captured } = fakeResponse()
    await usageRoute.handler(fakeRequest('GET', USAGE_ROUTE), res)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(ENDPOINT)
    expect(new Headers(seen[0]?.init?.headers).get('authorization')).toBe(`Bearer ${FAKE_KEY}`)

    expect(captured.status).toBe(200)
    const body = JSON.parse(captured.body) as UsageEnvelope
    expect(body.ok).toBe(true)
    if (!body.ok) throw new Error('expected a successful read')
    expect(body.snapshot.label).toBe('Go quota')

    // The route response carries the snapshot, never the key or its header.
    expect(captured.body).not.toContain(FAKE_KEY)
    expect(captured.body).not.toContain('Bearer')
    const headerText = Object.entries(captured.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n')
    expect(headerText).not.toContain(FAKE_KEY)
  })
})
