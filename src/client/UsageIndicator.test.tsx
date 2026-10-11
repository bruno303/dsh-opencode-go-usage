// @vitest-environment jsdom
/**
 * Component tests for the sidebar widget's transport lifecycle.
 *
 * These cover the parts `usage-view.test.ts` deliberately cannot: the mount
 * load, the "updated … ago" age the host reports, the ticking clock that keeps
 * the countdown live, the bounded poll, the POST refresh path with its in-flight
 * disable, and the no-write-after-unmount guard.
 *
 * Every test injects the fetch seam and (where a tick is involved) uses fake
 * timers, so nothing here opens a socket or leaves a real timer running. The
 * jest-dom matcher library is deliberately absent: assertions use plain vitest
 * expectations so the suite adds no further dependency.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QuotaWindow, UsageEnvelope, UsageFailureReason } from '../wire-types.js'
import { REFRESH_PATH, SNAPSHOT_AGE_HEADER, USAGE_PATH } from './usage-view.js'
import { DEFAULT_POLL_MS, TICK_MS, UsageIndicator } from './UsageIndicator.js'

const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const MINUTE = 60_000
const DAY = 86_400_000

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

/** A successful envelope; `fetchedAt` defaults to four minutes before {@link NOW}. */
function okEnvelope(
  overrides: { windows?: QuotaWindow[]; stale?: boolean; fetchedAt?: string } = {},
): Extract<UsageEnvelope, { ok: true }> {
  return {
    ok: true,
    snapshot: {
      label: 'OpenCode Go',
      fetchedAt: overrides.fetchedAt ?? at(-4 * MINUTE),
      stale: overrides.stale ?? false,
      limitReached: false,
      binding: 'monthly',
      windows: overrides.windows ?? [windowFixture()],
    },
  }
}

/** A JSON response, optionally carrying the host's snapshot-age header. */
function jsonResponse(body: unknown, init: { status?: number; ageMs?: number } = {}): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (init.ageMs !== undefined) headers[SNAPSHOT_AGE_HEADER] = String(init.ageMs)
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers })
}

/** A promise a test can settle by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** A fetch fake recording calls and answering through `respond`. */
function fakeFetch(respond: (call: { url: string; init: RequestInit | undefined }, index: number) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const call = { url: String(input), init }
    const index = calls.length
    calls.push(call)
    return respond(call, index)
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** Open the popover so its body is queryable. */
function openPopover(): void {
  fireEvent.click(screen.getByRole('button', { name: /usage|Usage/ }))
}

/** The Refresh button inside the popover. */
function refreshButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Refresh/ }) as HTMLButtonElement
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('UsageIndicator', () => {
  it('loads once on mount and renders every window on the indicator and in the popover', async () => {
    const envelope = okEnvelope({
      windows: [
        windowFixture({ id: 'rolling', label: '5h', percentUsed: 0.01, resetsAt: at(13 * 60 * MINUTE) }),
        windowFixture({ id: 'weekly', label: 'Weekly', percentUsed: 0.19, resetsAt: at(2 * DAY) }),
        windowFixture({ id: 'monthly', label: 'Monthly', percentUsed: 0.3, resetsAt: at(13 * DAY) }),
      ],
    })
    const fetchImpl = fakeFetch(() => jsonResponse(envelope))

    render(<UsageIndicator fetchImpl={fetchImpl.impl} now={() => NOW} pollMs={0} />)

    // Before the read resolves the widget is loading.
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Usage: loading')

    await waitFor(() => {
      expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
        'OpenCode Go usage: 5h 1%, Weekly 19%, Monthly 30%',
      )
    })

    expect(fetchImpl.calls).toHaveLength(1)
    expect(fetchImpl.calls[0]?.url).toBe(USAGE_PATH)
    expect(fetchImpl.calls[0]?.init?.method).toBe('GET')

    // The indicator carries all three windows without opening anything: the
    // binding percentage alone would hide a drained short window.
    const indicatorText = screen.getByRole('button', { name: /usage/i }).textContent ?? ''
    expect(indicatorText).toContain('5h')
    expect(indicatorText).toContain('1%')
    expect(indicatorText).toContain('wk')
    expect(indicatorText).toContain('19%')
    expect(indicatorText).toContain('mo')
    expect(indicatorText).toContain('30%')

    openPopover()

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('5h')).toBeDefined()
    expect(within(dialog).getByText('Weekly')).toBeDefined()
    expect(within(dialog).getByText('1%')).toBeDefined()
    expect(within(dialog).getByText('19%')).toBeDefined()
    // The binding window's percentage shows twice in the popover: its header and
    // its own row.
    expect(within(dialog).getAllByText('30%')).toHaveLength(2)
    expect(within(dialog).getByText(/resets in 13h/)).toBeDefined()
  })

  it('advances the reset countdown as the clock ticks', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const envelope = okEnvelope({
      windows: [windowFixture({ id: 'rolling', label: '5h', percentUsed: 0.01, resetsAt: at(30_000) })],
      fetchedAt: at(0),
    })
    const fetchImpl = fakeFetch(() => jsonResponse(envelope))

    render(<UsageIndicator fetchImpl={fetchImpl.impl} pollMs={0} />)
    await act(async () => {
      await Promise.resolve()
    })

    openPopover()
    expect(screen.getByText(/resets in 30s/)).toBeDefined()

    // Five one-second ticks: the countdown must have moved, which is only
    // possible if the view is recomputed from ticking clock state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * TICK_MS)
    })

    expect(screen.getByText(/resets in 25s/)).toBeDefined()
  })

  it('polls the usage route on the configured interval and stops on unmount', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const fetchImpl = fakeFetch(() => jsonResponse(okEnvelope()))

    const view = render(<UsageIndicator fetchImpl={fetchImpl.impl} pollMs={5000} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchImpl.calls).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(fetchImpl.calls).toHaveLength(2)

    view.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    // No poll may outlive the component.
    expect(fetchImpl.calls).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the default poll period when none is given', () => {
    expect(DEFAULT_POLL_MS).toBe(60_000)
  })

  it('marks a stale reading', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(okEnvelope({ stale: true })))

    render(<UsageIndicator fetchImpl={fetchImpl.impl} now={() => NOW} pollMs={0} />)
    await waitFor(() => {
      expect(screen.getByRole('button').getAttribute('aria-label')).toBe('OpenCode Go usage: Monthly 30% (stale)')
    })

    openPopover()
    expect(screen.getByText(/stale: the last provider read failed/)).toBeDefined()
  })

  it('uses the host-reported snapshot age so clock skew cannot lie about staleness', async () => {
    // The browser clock is three days off the server's `fetchedAt`; the host's
    // own age report is what the "Updated …" line must show.
    const envelope = okEnvelope({ fetchedAt: at(-3 * DAY) })
    const fetchImpl = fakeFetch(() => jsonResponse(envelope, { ageMs: 4 * MINUTE }))

    render(<UsageIndicator fetchImpl={fetchImpl.impl} now={() => NOW} pollMs={0} />)
    await waitFor(() => {
      expect(screen.getByRole('button').getAttribute('aria-label')).toBe('OpenCode Go usage: Monthly 30%')
    })

    openPopover()
    expect(screen.getByText(/Updated 4m ago/)).toBeDefined()
  })

  it('falls back to the browser clock when the host sends no age', async () => {
    const envelope = okEnvelope({ fetchedAt: at(-3 * DAY) })
    const fetchImpl = fakeFetch(() => jsonResponse(envelope))

    render(<UsageIndicator fetchImpl={fetchImpl.impl} now={() => NOW} pollMs={0} />)
    await waitFor(() => {
      expect(screen.getByRole('button').getAttribute('aria-label')).toBe('OpenCode Go usage: Monthly 30%')
    })

    openPopover()
    expect(screen.getByText(/Updated 3d ago/)).toBeDefined()
  })

  it('renders fixed copy for every failure reason and never server text', async () => {
    const expected: Record<UsageFailureReason, string> = {
      'key-missing': 'No API key is configured for this provider.',
      'key-invalid': 'The configured API key was rejected.',
      'not-found': 'The usage endpoint was not found.',
      network: 'Could not reach the usage endpoint.',
      parse: 'The usage response could not be read.',
      http: 'The usage endpoint returned an error.',
    }
    const SERVER_TEXT = 'Bearer sk-should-never-render'

    for (const [reason, copy] of Object.entries(expected) as Array<[UsageFailureReason, string]>) {
      const fetchImpl = fakeFetch(() => jsonResponse({ ok: false, reason, status: 418, message: SERVER_TEXT }))

      render(<UsageIndicator fetchImpl={fetchImpl.impl} now={() => NOW} pollMs={0} />)
      await waitFor(() => {
        expect(screen.getByRole('button').getAttribute('aria-label')).toBe(`Usage unavailable: ${copy}`)
      })

      openPopover()
      expect(screen.getByText(copy)).toBeDefined()
      expect(screen.getByText('HTTP 418')).toBeDefined()
      // The host's free-text message is never painted into the sidebar.
      expect(screen.queryByText(SERVER_TEXT)).toBeNull()

      cleanup()
    }
  })

  it('POSTs the refresh route, disables the button in flight, then commits the reading', async () => {
    const first = okEnvelope()
    const second = okEnvelope({ windows: [windowFixture({ percentUsed: 0.9 })] })
    const pending = deferred<Response>()
    const fetchImpl = fakeFetch((call) => (call.init?.method === 'POST' ? pending.promise : jsonResponse(first)))

    render(<UsageIndicator fetchImpl={fetchImpl.impl} now={() => NOW} pollMs={0} />)
    await waitFor(() => {
      expect(screen.getByRole('button').getAttribute('aria-label')).toBe('OpenCode Go usage: Monthly 30%')
    })

    openPopover()
    const button = refreshButton()
    expect(button.disabled).toBe(false)

    fireEvent.click(button)

    // In flight: disabled and relabelled until the response lands.
    await waitFor(() => {
      expect(refreshButton().disabled).toBe(true)
    })
    expect(refreshButton().textContent).toBe('Refreshing…')
    expect(fetchImpl.calls).toHaveLength(2)
    expect(fetchImpl.calls[1]?.url).toBe(REFRESH_PATH)
    expect(fetchImpl.calls[1]?.init?.method).toBe('POST')

    await act(async () => {
      pending.resolve(jsonResponse(second))
      await pending.promise
    })

    await waitFor(() => {
      expect(refreshButton().disabled).toBe(false)
    })
    expect(refreshButton().textContent).toBe('Refresh')
    expect(screen.getByRole('button', { name: /usage/ }).getAttribute('aria-label')).toBe('OpenCode Go usage: Monthly 90%')
  })

  it('lets only the newest request commit when responses arrive out of order', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const postResponse = deferred<Response>()
    const pollResponse = deferred<Response>()
    let gets = 0
    const fetchImpl = fakeFetch((call) => {
      if (call.init?.method === 'POST') return postResponse.promise
      gets += 1
      // The mount read settles at once; the later poll stays outstanding.
      return gets === 1 ? jsonResponse(okEnvelope()) : pollResponse.promise
    })

    render(<UsageIndicator fetchImpl={fetchImpl.impl} now={() => NOW} pollMs={5000} />)
    await act(async () => {
      await Promise.resolve()
    })
    openPopover()

    // A POST refresh (ticket 2) …
    fireEvent.click(refreshButton())
    // … then a poll GET (ticket 3) starts while it is still in flight.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(fetchImpl.calls).toHaveLength(3)

    // The newest settles first, then the superseded POST lands late.
    await act(async () => {
      pollResponse.resolve(jsonResponse(okEnvelope({ windows: [windowFixture({ percentUsed: 0.9 })] })))
      await pollResponse.promise
    })
    await act(async () => {
      postResponse.resolve(jsonResponse(okEnvelope({ windows: [windowFixture({ percentUsed: 0.01 })] })))
      await postResponse.promise
    })

    // The late response must not overwrite the newer reading, and the spinner
    // must have been cleared by the request that owned the ticket.
    expect(screen.getByRole('button', { name: /usage/ }).getAttribute('aria-label')).toBe('OpenCode Go usage: Monthly 90%')
    expect(refreshButton().disabled).toBe(false)
  })

  it('ignores a response that resolves after unmount without warning', async () => {
    const pending = deferred<Response>()
    const fetchImpl = fakeFetch(() => pending.promise)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const windowErrors = vi.fn()
    window.addEventListener('error', windowErrors)

    try {
      const view = render(<UsageIndicator fetchImpl={fetchImpl.impl} now={() => NOW} pollMs={0} />)
      view.unmount()

      await act(async () => {
        pending.resolve(jsonResponse(okEnvelope()))
        await pending.promise
        // Let the loader's continuation and its `finally` run to completion.
        await Promise.resolve()
        await Promise.resolve()
      })

      // React 18 makes a post-unmount state write a silent no-op, so the
      // load-bearing assertion is that nothing escapes: no diagnostic, no
      // window error, and no rejected continuation (which would fail the run).
      expect(errors).not.toHaveBeenCalled()
      expect(windowErrors).not.toHaveBeenCalled()
      // The unmounted widget left nothing behind to repaint.
      expect(document.body.textContent).toBe('')
    } finally {
      window.removeEventListener('error', windowErrors)
    }
  })

  it('shows all three windows when expanded and only the binding one in the 56px rail', async () => {
    const envelope = okEnvelope({
      windows: [
        windowFixture({ id: 'rolling', label: '5h', percentUsed: 0.01 }),
        windowFixture({ id: 'weekly', label: 'Weekly', percentUsed: 0.19 }),
        windowFixture({ id: 'monthly', label: 'Monthly', percentUsed: 0.3 }),
      ],
    })
    const fetchImpl = fakeFetch(() => jsonResponse(envelope))

    const { rerender } = render(<UsageIndicator wide={false} fetchImpl={fetchImpl.impl} now={() => NOW} pollMs={0} />)
    await waitFor(() => {
      expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
        'OpenCode Go usage: 5h 1%, Weekly 19%, Monthly 30%',
      )
    })

    // The rail has room for exactly one number: the binding window's.
    const railText = screen.getByRole('button').textContent ?? ''
    expect(railText).toContain('30%')
    expect(railText).not.toContain('19%')
    expect(railText).not.toContain('5h')

    rerender(<UsageIndicator wide fetchImpl={fetchImpl.impl} now={() => NOW} pollMs={0} />)

    const wideText = screen.getByRole('button').textContent ?? ''
    expect(wideText).toContain('5h')
    expect(wideText).toContain('1%')
    expect(wideText).toContain('19%')
    expect(wideText).toContain('30%')
  })

  it('places the popover inside the viewport when the widget sits at the left edge', async () => {
    // The sidebar footer is a full-width row at the window's left edge and the
    // column clips its overflow, so an absolutely positioned panel anchored to
    // this button landed off the left edge of the window. The panel must be
    // viewport-fixed and clamped inside it.
    const fetchImpl = fakeFetch(() => jsonResponse(okEnvelope()))
    const anchor = {
      x: 8,
      y: 700,
      top: 700,
      bottom: 728,
      left: 8,
      right: 36,
      width: 28,
      height: 28,
      toJSON: () => ({}),
    }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(anchor as DOMRect)

    render(<UsageIndicator fetchImpl={fetchImpl.impl} now={() => NOW} pollMs={0} />)
    await waitFor(() => {
      expect(screen.getByRole('button').getAttribute('aria-label')).toBe('OpenCode Go usage: Monthly 30%')
    })

    openPopover()

    const style = screen.getByRole('dialog').style
    const left = Number.parseFloat(style.left)
    const width = Number.parseFloat(style.width)

    expect(style.position).toBe('fixed')
    expect(left).toBeGreaterThanOrEqual(8)
    expect(left + width).toBeLessThanOrEqual(window.innerWidth - 8)
    // Room above the anchor, so the panel is pinned by its bottom edge.
    expect(style.bottom).not.toBe('')
    expect(style.top).toBe('')
  })
})
