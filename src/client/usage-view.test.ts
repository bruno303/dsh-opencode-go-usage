/**
 * Unit tests for the browser half's pure view model.
 *
 * No DOM and no real network: the fetch seam is always an injected fake, and
 * `fetch`/`Response` are only *types* or the platform's in-memory `Response`
 * implementation, so nothing here opens a socket.
 *
 * The one node-side import is `../route.js`, and it exists only to make the
 * route-literal drift guard below exact: `usage-view.ts` cannot import the
 * host module (it is node-side and would drag `node:http` and the cache into
 * the browser bundle), so the two literals are duplicated there and pinned
 * against the host exports here. This file is a test, never an entry point, so
 * the import cannot reach `lib/client.js`; `docs/testing.md` records the build
 * assertion that proves it.
 */
import { describe, expect, it } from 'vitest'
import type { QuotaWindow, UsageEnvelope } from '../wire-types.js'
import { REFRESH_ROUTE, USAGE_ROUTE } from '../route.js'
import {
  describeEnvelope,
  fetchUsage,
  formatCountdown,
  formatPercent,
  parseServerAgeMs,
  placePopover,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  refreshUsage,
  REFRESH_PATH,
  SNAPSHOT_AGE_HEADER,
  USAGE_PATH,
  windowSeverity,
  type UsageErrorView,
  type UsageOkView,
} from './usage-view.js'

const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** An ISO instant `offsetMs` away from {@link NOW}. */
function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString()
}

/** One valid window. */
function windowFixture(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    id: 'monthly',
    label: 'Monthly',
    status: 'ok',
    percentUsed: 0.3,
    resetsAt: at(13 * DAY),
    limitReached: false,
    ...overrides,
  }
}

/** A successful envelope with the three verified windows. */
function okEnvelope(
  overrides: {
    windows?: QuotaWindow[]
    binding?: string | null
    stale?: boolean
    limitReached?: boolean
    fetchedAt?: string
  } = {},
): Extract<UsageEnvelope, { ok: true }> {
  return {
    ok: true,
    snapshot: {
      label: 'OpenCode Go',
      fetchedAt: overrides.fetchedAt ?? at(-4 * MINUTE),
      stale: overrides.stale ?? false,
      limitReached: overrides.limitReached ?? false,
      binding: overrides.binding === undefined ? 'monthly' : overrides.binding,
      windows: overrides.windows ?? [windowFixture()],
    },
  }
}

/** A fetch fake that records its calls and answers from `respond`. */
function fakeFetch(
  respond: (url: string, init: RequestInit | undefined) => Response,
): { impl: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const impl: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    return respond(url, init)
  }
  return { impl, calls }
}

/** A JSON response carrying `body`; `headers` carries the host's age report. */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

describe('route constants', () => {
  it('pins the client literals to the host exports (drift guard)', () => {
    // The literal route strings are the contract between the two halves. The
    // expected values are asserted directly so a change to *either* side fails
    // here, and the host exports are compared so a host-side rename cannot be
    // mirrored by editing only this file's literals.
    expect(USAGE_PATH).toBe('/__dsh_opencode_go_usage__/usage')
    expect(REFRESH_PATH).toBe('/__dsh_opencode_go_usage__/refresh')
    expect(USAGE_PATH).toBe(USAGE_ROUTE)
    expect(REFRESH_PATH).toBe(REFRESH_ROUTE)
    // The response header literal is duplicated for the same reason; the host
    // side of it is pinned by `src/route.test.ts`.
    expect(SNAPSHOT_AGE_HEADER).toBe('X-Usage-Snapshot-Age-Ms')
  })
})

describe('formatPercent', () => {
  it('renders a fraction as a whole percentage', () => {
    expect(formatPercent(0.19)).toBe('19%')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(1)).toBe('100%')
  })

  it('clamps out-of-range fractions', () => {
    expect(formatPercent(-0.5)).toBe('0%')
    expect(formatPercent(1.4)).toBe('100%')
  })

  it('rounds to the nearest integer', () => {
    expect(formatPercent(0.194)).toBe('19%')
    expect(formatPercent(0.195)).toBe('20%')
    expect(formatPercent(0.196)).toBe('20%')
    expect(formatPercent(0.005)).toBe('1%')
  })

  it('fails down to 0% on a non-finite reading', () => {
    expect(formatPercent(Number.NaN)).toBe('0%')
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('0%')
  })
})

describe('formatCountdown', () => {
  it('renders two coarse units across days and hours', () => {
    expect(formatCountdown(at(3 * DAY + 4 * HOUR), NOW)).toBe('in 3d 4h')
    expect(formatCountdown(at(3 * DAY), NOW)).toBe('in 3d')
    expect(formatCountdown(at(3 * DAY + 30 * MINUTE), NOW)).toBe('in 3d')
  })

  it('renders hours and minutes', () => {
    expect(formatCountdown(at(5 * HOUR + 12 * MINUTE), NOW)).toBe('in 5h 12m')
    expect(formatCountdown(at(5 * HOUR), NOW)).toBe('in 5h')
  })

  it('renders minutes alone and seconds alone', () => {
    expect(formatCountdown(at(47 * MINUTE), NOW)).toBe('in 47m')
    expect(formatCountdown(at(47 * MINUTE + 59_000), NOW)).toBe('in 47m')
    expect(formatCountdown(at(30_000), NOW)).toBe('in 30s')
    expect(formatCountdown(at(1), NOW)).toBe('in 0s')
  })

  it('reports a due or past instant as now', () => {
    expect(formatCountdown(at(0), NOW)).toBe('now')
    expect(formatCountdown(at(-1), NOW)).toBe('now')
    expect(formatCountdown(at(-5 * DAY), NOW)).toBe('now')
  })

  it('reports an unparseable instant as unknown', () => {
    expect(formatCountdown('', NOW)).toBe('unknown')
    expect(formatCountdown('not a date', NOW)).toBe('unknown')
  })
})

describe('windowSeverity', () => {
  it('grades below the warning threshold as ok', () => {
    expect(windowSeverity(0.79, false)).toBe('ok')
    expect(windowSeverity(0, false)).toBe('ok')
  })

  it('grades at or above the threshold as warning', () => {
    expect(windowSeverity(0.8, false)).toBe('warning')
    expect(windowSeverity(0.95, false)).toBe('warning')
    // Severity comes from the provider's refusal, not from the arithmetic.
    expect(windowSeverity(1, false)).toBe('warning')
  })

  it('grades a refused window as critical regardless of percentage', () => {
    expect(windowSeverity(0, true)).toBe('critical')
    expect(windowSeverity(0.5, true)).toBe('critical')
  })
})

describe('parseServerAgeMs', () => {
  it('accepts a plain non-negative millisecond count, trimming whitespace', () => {
    expect(parseServerAgeMs('0')).toBe(0)
    expect(parseServerAgeMs('250')).toBe(250)
    expect(parseServerAgeMs('  60000 ')).toBe(60_000)
  })

  it('treats an absent or unusable header as no report at all', () => {
    // `undefined` is what makes `describeEnvelope` fall back to `fetchedAt`.
    expect(parseServerAgeMs(null)).toBeUndefined()
    expect(parseServerAgeMs('')).toBeUndefined()
    expect(parseServerAgeMs('   ')).toBeUndefined()
    expect(parseServerAgeMs('1.2.3')).toBeUndefined()
    expect(parseServerAgeMs('12ms')).toBeUndefined()
    expect(parseServerAgeMs('NaN')).toBeUndefined()
    expect(parseServerAgeMs('Infinity')).toBeUndefined()
    expect(parseServerAgeMs('-1')).toBeUndefined()
  })
})

describe('describeEnvelope', () => {
  it('reports loading before the first read', () => {
    expect(describeEnvelope(undefined, NOW)).toEqual({ kind: 'loading' })
  })

  it('projects a readable snapshot', () => {
    const envelope = okEnvelope({
      windows: [
        windowFixture({ id: 'rolling', label: '5h', percentUsed: 0.01, resetsAt: at(13 * HOUR) }),
        windowFixture({ id: 'weekly', label: 'Weekly', percentUsed: 0.19, resetsAt: at(2 * DAY) }),
        windowFixture({ id: 'monthly', label: 'Monthly', percentUsed: 0.3, resetsAt: at(13 * DAY) }),
      ],
    })

    const view = describeEnvelope(envelope, NOW)

    expect(view.kind).toBe('ok')
    if (view.kind !== 'ok') throw new Error('expected an ok view')
    expect(view).toEqual<UsageOkView>({
      kind: 'ok',
      label: 'OpenCode Go',
      binding: 'monthly',
      percentText: '30%',
      severity: 'ok',
      stale: false,
      fetchedAtText: '4m ago',
      windows: [
        { id: 'rolling', label: '5h', shortLabel: '5h', percentText: '1%', severity: 'ok', resetsIn: 'in 13h', limitReached: false },
        { id: 'weekly', label: 'Weekly', shortLabel: 'wk', percentText: '19%', severity: 'ok', resetsIn: 'in 2d', limitReached: false },
        { id: 'monthly', label: 'Monthly', shortLabel: 'mo', percentText: '30%', severity: 'ok', resetsIn: 'in 13d', limitReached: false },
      ],
    })
    // Readable snapshots carry no failure copy at all.
    expect(JSON.stringify(view)).not.toContain('Could not')
    expect(view).not.toHaveProperty('message')
  })

  it('shortens an unknown window id to its own label instead of dropping it', () => {
    const view = describeEnvelope(
      okEnvelope({
        windows: [windowFixture({ id: 'daily', label: 'Daily', percentUsed: 0.5 })],
        binding: 'daily',
      }),
      NOW,
    )

    expect(view.kind).toBe('ok')
    if (view.kind !== 'ok') throw new Error('expected an ok view')
    // The indicator must still show a window the host adds later.
    expect(view.windows[0]?.shortLabel).toBe('Da')
  })

  it('carries the stale flag through', () => {
    const view = describeEnvelope(okEnvelope({ stale: true }), NOW)

    expect(view.kind).toBe('ok')
    if (view.kind !== 'ok') throw new Error('expected an ok view')
    expect(view.stale).toBe(true)
  })

  it('grades the binding window high when it is the most used one', () => {
    const view = describeEnvelope(
      okEnvelope({
        binding: 'rolling',
        limitReached: true,
        windows: [windowFixture({ id: 'rolling', label: '5h', percentUsed: 1, status: 'rate-limited', limitReached: true })],
      }),
      NOW,
    )

    expect(view.kind).toBe('ok')
    if (view.kind !== 'ok') throw new Error('expected an ok view')
    expect(view.percentText).toBe('100%')
    expect(view.severity).toBe('critical')
    expect(view.windows[0]?.limitReached).toBe(true)
  })

  it('degrades gracefully when no window parsed', () => {
    const view = describeEnvelope(okEnvelope({ binding: null, windows: [] }), NOW)

    expect(view.kind).toBe('ok')
    if (view.kind !== 'ok') throw new Error('expected an ok view')
    expect(view.binding).toBeNull()
    expect(view.percentText).toBe('—')
    expect(view.severity).toBe('ok')
    expect(view.windows).toEqual([])
  })

  it('escalates a no-window snapshot whose limit flag is set', () => {
    const view = describeEnvelope(okEnvelope({ binding: null, windows: [], limitReached: true }), NOW)

    expect(view.kind).toBe('ok')
    if (view.kind !== 'ok') throw new Error('expected an ok view')
    expect(view.severity).toBe('critical')
  })

  it('reports unknown relative age for an unparseable fetchedAt', () => {
    const view = describeEnvelope(okEnvelope({ fetchedAt: 'not a date' }), NOW)

    expect(view.kind).toBe('ok')
    if (view.kind !== 'ok') throw new Error('expected an ok view')
    expect(view.fetchedAtText).toBe('unknown')
  })

  it('maps every failure reason to fixed, human copy and surfaces the status', () => {
    const expected: Record<string, string> = {
      'key-missing': 'No API key is configured for this provider.',
      'key-invalid': 'The configured API key was rejected.',
      'not-found': 'The usage endpoint was not found.',
      network: 'Could not reach the usage endpoint.',
      parse: 'The usage response could not be read.',
      http: 'The usage endpoint returned an error.',
    }

    for (const [reason, message] of Object.entries(expected)) {
      const view = describeEnvelope(
        { ok: false, reason: reason as UsageErrorView['reason'], status: 418, message: 'server text is ignored' },
        NOW,
      )

      expect(view).toEqual<UsageErrorView>({ kind: 'error', reason: reason as UsageErrorView['reason'], message, status: 418 })
    }
  })

  it('omits the status when the envelope carried none', () => {
    const view = describeEnvelope({ ok: false, reason: 'network' }, NOW)

    expect(view).toEqual<UsageErrorView>({
      kind: 'error',
      reason: 'network',
      message: 'Could not reach the usage endpoint.',
    })
    expect(view).not.toHaveProperty('status')
  })

  it('prefers the host-reported age over the browser clock (skew guard)', () => {
    // The host says the snapshot is 4 minutes old. The browser's clock disagrees
    // by three days — exactly the skew the header exists to absorb — and the
    // host's measurement must win.
    const skewed = okEnvelope({ fetchedAt: at(-3 * DAY) })

    const withHeader = describeEnvelope(skewed, NOW, 4 * MINUTE)
    const withoutHeader = describeEnvelope(skewed, NOW)

    expect(withHeader.kind).toBe('ok')
    if (withHeader.kind !== 'ok') throw new Error('expected an ok view')
    expect(withHeader.fetchedAtText).toBe('4m ago')

    expect(withoutHeader.kind).toBe('ok')
    if (withoutHeader.kind !== 'ok') throw new Error('expected an ok view')
    expect(withoutHeader.fetchedAtText).toBe('3d ago')
  })

  it('clamps a negative host-reported age to just now', () => {
    const view = describeEnvelope(okEnvelope(), NOW, -5000)

    expect(view.kind).toBe('ok')
    if (view.kind !== 'ok') throw new Error('expected an ok view')
    expect(view.fetchedAtText).toBe('just now')
  })

  it('keeps the fetchedAt fallback for every age bucket when no header is present', () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [30_000, 'just now'],
      [4 * MINUTE, '4m ago'],
      [5 * HOUR, '5h ago'],
      [2 * DAY, '2d ago'],
    ]

    for (const [age, expected] of cases) {
      const view = describeEnvelope(okEnvelope({ fetchedAt: at(-age) }), NOW)
      expect(view.kind).toBe('ok')
      if (view.kind !== 'ok') throw new Error('expected an ok view')
      expect(view.fetchedAtText).toBe(expected)
    }
  })

  it('never renders a credential-looking token from a server message', () => {
    const SECRET = 'sk-live-abcdef0123456789'
    const views = [
      describeEnvelope({ ok: false, reason: 'key-invalid', status: 401, message: `Bearer ${SECRET} was rejected` }, NOW),
      describeEnvelope({ ok: false, reason: 'key-missing', message: `credential OPENCODE_GO_API_KEY=${SECRET} is not set` }, NOW),
      describeEnvelope({ ok: false, reason: 'network', message: `failed for ${SECRET}` }, NOW),
      describeEnvelope({ ok: false, reason: 'parse', status: 200, message: `${SECRET}\n<html>` }, NOW),
    ]

    const rendered = JSON.stringify(views)
    expect(rendered).not.toContain(SECRET)
    expect(rendered).not.toMatch(/sk-[A-Za-z0-9]{8,}/)
    expect(rendered).not.toContain('Bearer')
  })
})

describe('fetchUsage', () => {
  it('GETs the usage route with the Accept header and same-origin credentials', async () => {
    const envelope = okEnvelope()
    const { impl, calls } = fakeFetch(() => jsonResponse(envelope))

    const result = await fetchUsage(impl, USAGE_PATH)

    expect(result.envelope).toEqual(envelope)
    // No age header on this response, so the view must fall back to `fetchedAt`.
    expect(result.serverAgeMs).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(USAGE_PATH)
    expect(calls[0]?.init?.method).toBe('GET')
    expect(calls[0]?.init?.credentials).toBe('same-origin')
    expect(new Headers(calls[0]?.init?.headers).get('accept')).toBe('application/json')
  })

  it('reads the host snapshot-age header into the read result', async () => {
    const envelope = okEnvelope()
    const { impl } = fakeFetch(() => jsonResponse(envelope, 200, { [SNAPSHOT_AGE_HEADER]: '900' }))

    const result = await fetchUsage(impl, USAGE_PATH)

    expect(result.envelope).toEqual(envelope)
    expect(result.serverAgeMs).toBe(900)
  })

  it('ignores an unusable age header instead of failing the read', async () => {
    const envelope = okEnvelope()
    const { impl } = fakeFetch(() => jsonResponse(envelope, 200, { [SNAPSHOT_AGE_HEADER]: 'not-a-number' }))

    const result = await fetchUsage(impl, USAGE_PATH)

    expect(result).toEqual({ envelope })
  })

  it('passes a host failure envelope through unchanged', async () => {
    const failure: UsageEnvelope = { ok: false, reason: 'key-missing', message: 'credential OPENCODE_GO_API_KEY is not set' }
    const { impl } = fakeFetch(() => jsonResponse(failure))

    await expect(fetchUsage(impl, USAGE_PATH)).resolves.toEqual({ envelope: failure })
  })

  it('resolves a non-JSON body as a network failure', async () => {
    const { impl } = fakeFetch(() => new Response('<html>proxy</html>', { status: 200 }))

    const result = await fetchUsage(impl, USAGE_PATH)

    expect(result.envelope).toEqual({ ok: false, reason: 'network', message: 'Could not reach the usage endpoint.' })
  })

  it('maps non-2xx statuses without throwing', async () => {
    const cases: Array<{ status: number; reason: string }> = [
      { status: 500, reason: 'http' },
      { status: 401, reason: 'http' },
      { status: 403, reason: 'http' },
      { status: 405, reason: 'http' },
      { status: 404, reason: 'not-found' },
    ]

    for (const scenario of cases) {
      const { impl } = fakeFetch(() => new Response('denied', { status: scenario.status }))
      const result = await fetchUsage(impl, USAGE_PATH)

      expect(result.envelope).toEqual({
        ok: false,
        reason: scenario.reason,
        status: scenario.status,
        message: scenario.reason === 'not-found' ? 'The usage endpoint was not found.' : 'The usage endpoint returned an error.',
      })
      // A failed read reports no snapshot, so there is no age to carry.
      expect(result.serverAgeMs).toBeUndefined()
    }
  })

  it('resolves a rejecting fetch as a network failure', async () => {
    const impl: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3080')
    }

    const result = await fetchUsage(impl, USAGE_PATH)

    expect(result.envelope).toEqual({ ok: false, reason: 'network', message: 'Could not reach the usage endpoint.' })
    expect(JSON.stringify(result)).not.toContain('ECONNREFUSED')
  })

  it('resolves a drifted JSON shape as a parse failure', async () => {
    const { impl } = fakeFetch(() => jsonResponse({ ok: true, snapshot: { label: 'x', fetchedAt: 'y', stale: false, limitReached: false, binding: null, windows: [null] } }))

    await expect(fetchUsage(impl, USAGE_PATH)).resolves.toEqual({
      envelope: {
        ok: false,
        reason: 'parse',
        message: 'The usage response could not be read.',
      },
    })
  })

  it('never throws for any transport outcome', async () => {
    const bodies: Array<() => Response> = [
      () => jsonResponse(okEnvelope(), 200, { [SNAPSHOT_AGE_HEADER]: '42' }),
      () => jsonResponse({ ok: false, reason: 'http', status: 500 }),
      () => new Response('nope', { status: 503 }),
      () => new Response(null, { status: 204 }),
    ]

    for (const body of bodies) {
      const { impl } = fakeFetch(body)
      await expect(fetchUsage(impl, USAGE_PATH)).resolves.toHaveProperty('envelope.ok')
    }
  })
})

describe('refreshUsage', () => {
  it('POSTs the refresh route with the same headers', async () => {
    const envelope = okEnvelope({ stale: true })
    const { impl, calls } = fakeFetch(() => jsonResponse(envelope))

    const result = await refreshUsage(impl, REFRESH_PATH)

    expect(result.envelope).toEqual(envelope)
    expect(calls[0]?.url).toBe(REFRESH_PATH)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.credentials).toBe('same-origin')
    expect(new Headers(calls[0]?.init?.headers).get('accept')).toBe('application/json')
  })

  it('reads the host snapshot-age header on a refresh too', async () => {
    const envelope = okEnvelope({ stale: true })
    const { impl } = fakeFetch(() => jsonResponse(envelope, 200, { [SNAPSHOT_AGE_HEADER]: '120' }))

    const result = await refreshUsage(impl, REFRESH_PATH)

    expect(result.envelope).toEqual(envelope)
    expect(result.serverAgeMs).toBe(120)
  })

  it('resolves a rejecting fetch as a network failure', async () => {
    const impl: typeof fetch = async () => {
      throw new Error('offline')
    }

    await expect(refreshUsage(impl, REFRESH_PATH)).resolves.toEqual({
      envelope: {
        ok: false,
        reason: 'network',
        message: 'Could not reach the usage endpoint.',
      },
    })
  })

  it('maps a non-JSON body as a network failure', async () => {
    const { impl } = fakeFetch(() => new Response('not json', { status: 200 }))

    await expect(refreshUsage(impl, REFRESH_PATH)).resolves.toEqual({
      envelope: {
        ok: false,
        reason: 'network',
        message: 'Could not reach the usage endpoint.',
      },
    })
  })
})

describe('placePopover', () => {
  const viewport = { width: 1200, height: 800 }

  it('keeps the panel inside the window when the anchor sits at the left edge', () => {
    // Regression: the widget is the first item of a full-width sidebar footer
    // row, so an anchor at x≈8 used to place a 260px panel at x≈-224 — off the
    // left edge of the window, and clipped by the sidebar column.
    const placement = placePopover({ top: 700, bottom: 728, left: 8, right: 36 }, viewport)

    expect(placement.left).toBe(POPOVER_MARGIN)
    expect(placement.left).toBeGreaterThanOrEqual(0)
    expect(placement.left + placement.width).toBeLessThanOrEqual(viewport.width - POPOVER_MARGIN)
  })

  it('clamps the left edge so the panel never crosses the right edge', () => {
    const placement = placePopover({ top: 700, bottom: 728, left: 1190, right: 1198 }, viewport)

    expect(placement.left + placement.width).toBe(viewport.width - POPOVER_MARGIN)
  })

  it('shrinks the panel to the viewport when the window is narrower than the preferred width', () => {
    const narrow = { width: 200, height: 600 }
    const placement = placePopover({ top: 500, bottom: 528, left: 8, right: 36 }, narrow)

    expect(placement.width).toBe(narrow.width - POPOVER_MARGIN * 2)
    expect(placement.left).toBe(POPOVER_MARGIN)
  })

  it('opens above the anchor when there is room, pinned by its own bottom edge', () => {
    const placement = placePopover({ top: 700, bottom: 728, left: 40, right: 68 }, viewport)

    expect(placement.side).toBe('above')
    expect(placement.bottom).toBe(viewport.height - 700 + POPOVER_MARGIN)
    expect(placement.top).toBeNull()
  })

  it('flips below the anchor when there is no usable room above', () => {
    const placement = placePopover({ top: 20, bottom: 48, left: 40, right: 68 }, viewport)

    expect(placement.side).toBe('below')
    expect(placement.top).toBe(48 + POPOVER_MARGIN)
    expect(placement.bottom).toBeNull()
  })

  it('leaves a comfortably placed anchor untouched and uses the preferred width', () => {
    const placement = placePopover({ top: 700, bottom: 728, left: 400, right: 428 }, viewport)

    expect(placement.left).toBe(400)
    expect(placement.width).toBe(POPOVER_WIDTH)
  })
})
