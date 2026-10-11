import { describe, expect, it } from 'vitest'
import { parseUsagePayload, type ParseUsageResult } from './quota-parse.js'

/** Narrow to the success arm or fail loudly. */
function expectOk(result: ParseUsageResult): Extract<ParseUsageResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected a successful parse, got: ${result.message}`)
  return result
}

/** A valid window payload with the given overrides. */
function window(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: 'ok', percent: 50, resetsAt: '2026-10-11T01:21:36.000Z', ...overrides }
}

/** The verified live shape (values from the 2026-10-10 call). */
const LIVE_PAYLOAD = {
  usage: {
    rolling: { status: 'ok', percent: 1, resetsAt: '2026-10-11T01:21:36.000Z' },
    weekly: { status: 'ok', percent: 19, resetsAt: '2026-10-12T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 30, resetsAt: '2026-10-23T21:44:23.000Z' },
  },
}

describe('parseUsagePayload', () => {
  it('parses the verified three-window payload in provider order', () => {
    const result = expectOk(parseUsagePayload(LIVE_PAYLOAD))

    expect(result.windows).toEqual([
      {
        id: 'rolling',
        label: '5h',
        status: 'ok',
        percentUsed: 1 / 100,
        resetsAt: '2026-10-11T01:21:36.000Z',
        limitReached: false,
      },
      {
        id: 'weekly',
        label: 'Weekly',
        status: 'ok',
        percentUsed: 19 / 100,
        resetsAt: '2026-10-12T00:00:00.000Z',
        limitReached: false,
      },
      {
        id: 'monthly',
        label: 'Monthly',
        status: 'ok',
        percentUsed: 30 / 100,
        resetsAt: '2026-10-23T21:44:23.000Z',
        limitReached: false,
      },
    ])
    expect(result.binding).toBe('monthly')
    expect(result.limitReached).toBe(false)
  })

  it('accepts percent 0 as a valid, unexhausted window', () => {
    const result = expectOk(parseUsagePayload({ usage: { rolling: window({ percent: 0 }) } }))

    expect(result.windows).toHaveLength(1)
    expect(result.windows[0]?.percentUsed).toBe(0)
    expect(result.windows[0]?.limitReached).toBe(false)
    expect(result.limitReached).toBe(false)
  })

  it('treats percent 100 as exhausted', () => {
    const result = expectOk(parseUsagePayload({ usage: { monthly: window({ percent: 100 }) } }))

    expect(result.windows[0]?.percentUsed).toBe(1)
    expect(result.windows[0]?.limitReached).toBe(true)
    expect(result.limitReached).toBe(true)
    expect(result.binding).toBe('monthly')
  })

  it('drops windows whose percent is out of range', () => {
    const result = expectOk(
      parseUsagePayload({
        usage: { rolling: window({ percent: 101 }), weekly: window({ percent: -1 }), monthly: window() },
      }),
    )

    expect(result.windows.map((entry) => entry.id)).toEqual(['monthly'])
  })

  it('drops windows whose percent is not a finite number', () => {
    const result = expectOk(
      parseUsagePayload({
        usage: {
          rolling: window({ percent: Number.NaN }),
          weekly: window({ percent: Number.POSITIVE_INFINITY }),
          monthly: window(),
        },
      }),
    )

    expect(result.windows.map((entry) => entry.id)).toEqual(['monthly'])
  })

  it('drops a window whose percent is not a number at all', () => {
    const result = expectOk(
      parseUsagePayload({ usage: { rolling: window({ percent: '50' }), weekly: window() } }),
    )

    expect(result.windows.map((entry) => entry.id)).toEqual(['weekly'])
  })

  it('reports a parse failure when every window was dropped', () => {
    const result = parseUsagePayload({
      usage: { rolling: window({ percent: 101 }), weekly: window({ status: 'exhausted' }) },
    })

    expect(result).toEqual({
      ok: false,
      reason: 'parse',
      message: 'response carried no usable usage windows',
    })
  })

  it('drops a window with an unknown status', () => {
    const result = expectOk(
      parseUsagePayload({ usage: { rolling: window({ status: 'exhausted' }), weekly: window() } }),
    )

    expect(result.windows.map((entry) => entry.id)).toEqual(['weekly'])
  })

  it('treats rate-limited as fully used regardless of the reported percent', () => {
    const result = expectOk(
      parseUsagePayload({ usage: { rolling: window({ status: 'rate-limited', percent: 3 }) } }),
    )

    expect(result.windows[0]?.percentUsed).toBe(1)
    expect(result.windows[0]?.limitReached).toBe(true)
    expect(result.limitReached).toBe(true)
  })

  it('drops windows with a missing or empty resetsAt', () => {
    const result = expectOk(
      parseUsagePayload({
        usage: {
          rolling: window({ resetsAt: undefined }),
          weekly: window({ resetsAt: '' }),
          monthly: window(),
        },
      }),
    )

    expect(result.windows.map((entry) => entry.id)).toEqual(['monthly'])
  })

  it('drops a whitespace-only resetsAt', () => {
    const result = expectOk(
      parseUsagePayload({ usage: { rolling: window({ resetsAt: '   ' }), weekly: window() } }),
    )

    expect(result.windows.map((entry) => entry.id)).toEqual(['weekly'])
  })

  it('drops resetsAt values that Date.parse cannot read', () => {
    const result = expectOk(
      parseUsagePayload({ usage: { rolling: window({ resetsAt: 'soon' }), weekly: window() } }),
    )

    expect(result.windows.map((entry) => entry.id)).toEqual(['weekly'])
  })

  it('drops a non-string resetsAt', () => {
    const result = expectOk(
      parseUsagePayload({
        usage: { rolling: window({ resetsAt: 1_700_000_000_000 }), weekly: window() },
      }),
    )

    expect(result.windows.map((entry) => entry.id)).toEqual(['weekly'])
  })

  it('parses only the known window keys and ignores unknown ones', () => {
    const result = expectOk(
      parseUsagePayload({
        usage: { rolling: window(), daily: window({ percent: 90 }), extra: 'ignored' },
        somethingElse: { rolling: window({ percent: 99 }) },
      }),
    )

    expect(result.windows.map((entry) => entry.id)).toEqual(['rolling'])
    expect(result.binding).toBe('rolling')
  })

  it('ignores unknown extra fields inside a window', () => {
    const result = expectOk(
      parseUsagePayload({
        usage: { rolling: window({ provider: 'opencode', percentRemaining: 99 }) },
      }),
    )

    expect(result.windows[0]).toEqual({
      id: 'rolling',
      label: '5h',
      status: 'ok',
      percentUsed: 0.5,
      resetsAt: '2026-10-11T01:21:36.000Z',
      limitReached: false,
    })
  })

  it('fails when the payload carries no usable usage object', () => {
    const inputs: unknown[] = [
      null,
      undefined,
      0,
      'usage',
      [],
      { usage: null },
      { usage: [] },
      { usage: 'nope' },
      { usage: 7 },
      {},
    ]

    for (const input of inputs) {
      const result = parseUsagePayload(input)
      expect(result.ok, `expected failure for ${JSON.stringify(input)}`).toBe(false)
      if (!result.ok) expect(result.reason).toBe('parse')
    }
  })

  it('never throws on malformed input', () => {
    const inputs: unknown[] = [Symbol('x'), () => undefined, new Date(), new Map(), { usage: new Map() }]

    for (const input of inputs) {
      expect(() => parseUsagePayload(input)).not.toThrow()
    }
  })

  it('binds the window with the highest percentUsed', () => {
    const result = expectOk(
      parseUsagePayload({
        usage: { rolling: window({ percent: 10 }), weekly: window({ percent: 80 }), monthly: window({ percent: 20 }) },
      }),
    )

    expect(result.binding).toBe('weekly')
  })

  it('breaks binding ties toward the shorter window', () => {
    const rollingWeekly = expectOk(
      parseUsagePayload({
        usage: { rolling: window({ percent: 50 }), weekly: window({ percent: 50 }), monthly: window({ percent: 1 }) },
      }),
    )
    expect(rollingWeekly.binding).toBe('rolling')

    const weeklyMonthly = expectOk(
      parseUsagePayload({
        usage: { weekly: window({ percent: 50 }), monthly: window({ percent: 50 }) },
      }),
    )
    expect(weeklyMonthly.binding).toBe('weekly')
  })

  it('treats a rate-limited window as binding even with a lower percent', () => {
    const result = expectOk(
      parseUsagePayload({
        usage: {
          rolling: window({ status: 'rate-limited', percent: 0 }),
          monthly: window({ percent: 99 }),
        },
      }),
    )

    expect(result.binding).toBe('rolling')
    expect(result.limitReached).toBe(true)
  })

  it('reports overall limitReached when any single window is exhausted', () => {
    const result = expectOk(
      parseUsagePayload({
        usage: { rolling: window({ percent: 1 }), weekly: window({ percent: 100 }), monthly: window({ percent: 2 }) },
      }),
    )

    expect(result.limitReached).toBe(true)
    expect(result.binding).toBe('weekly')
  })
})
