/**
 * The `sidebar.footer.action` occupant: a compact quota indicator plus its
 * detail popover.
 *
 * Deliberately thin. Every formatting, severity, and copy decision comes from
 * `usage-view.ts`, so what is left here is the transport lifecycle (one load on
 * mount, a bounded poll, refresh on demand) and the inline-styled markup.
 * Styling is inline and reads the shell's `--dsw-alias-*` custom properties with
 * fallbacks: the plugin ships no CSS file and imports no UI library.
 *
 * The component owns the timers: a 1 s clock tick so the countdown and the
 * "updated … ago" line actually advance, and a bounded poll so the reading
 * itself stays current (the host's `refreshSeconds` TTL dedupes the upstream
 * calls). Both are cleared on unmount, and no state is written after unmount.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  describeEnvelope,
  fetchUsage,
  placePopover,
  refreshUsage,
  REFRESH_PATH,
  USAGE_PATH,
  type PopoverPlacement,
  type UsageOkView,
  type UsageRead,
  type UsageView,
  type UsageWindowView,
  type WindowSeverity,
} from './usage-view.js'

/** Props: the slot owner share plus injection seams used by tests. */
export interface UsageIndicatorProps {
  /** Sidebar column state from {@link SidebarFooterActionOwnerProps}; `false` is the 56px rail. */
  wide?: boolean
  /** Fetch seam; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch
  /** Clock seam for relative copy; defaults to `Date.now`. */
  now?: () => number
  /** Periodic re-read interval in milliseconds; `0` disables polling. @default 60000 */
  pollMs?: number
}

/**
 * Clock-tick period. The countdown copy has second granularity (`in 30s`), so a
 * one-second tick is the coarsest interval that never shows a stale second.
 */
export const TICK_MS = 1000

/**
 * Default poll period: one `GET` a minute, which is the configured server TTL as
 * well, so a poll can never outrun the provider. The host's single-flight cache
 * makes even a burst of widgets cost one upstream request.
 */
export const DEFAULT_POLL_MS = 60_000

/** Severity colours, resolved from the shell theme with a readable fallback. */
const SEVERITY_COLOR: Record<WindowSeverity, string> = {
  ok: 'var(--dsw-alias-state-success-primary, #2e9e5b)',
  warning: 'var(--dsw-alias-state-warn-primary, #d29922)',
  critical: 'var(--dsw-alias-state-error-primary, #f85149)',
}

const MUTED = 'var(--dsw-alias-label-secondary, inherit)'
const BORDER = 'var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.35))'
const SURFACE = 'var(--dsw-alias-bg-overlay, #1f1f23)'

/** Shared text style so every popover line inherits the shell's font. */
const TEXT: CSSProperties = { color: 'inherit', font: 'inherit', lineHeight: 1.4 }

/**
 * Bar width from the already-formatted percentage.
 *
 * `percentText` is `formatPercent`'s clamped `NN%` output, or the no-window
 * placeholder when nothing parsed — so this is the one presentational number the
 * component derives itself.
 */
function barWidth(percentText: string): string {
  const value = Number.parseFloat(percentText)
  if (!Number.isFinite(value)) return '0%'
  return `${String(Math.min(100, Math.max(0, value)))}%`
}

/** The severity dot: the only always-visible signal in the collapsed rail. */
function SeverityDot({ severity }: { severity: WindowSeverity }): ReactNode {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        flex: '0 0 auto',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: SEVERITY_COLOR[severity],
      }}
    />
  )
}

/** One quota window row: label, percent bar, countdown. */
function WindowRow({ window }: { window: UsageWindowView }): ReactNode {
  return (
    <div style={{ display: 'grid', gap: 4, ...TEXT }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <SeverityDot severity={window.severity} />
          <span>{window.label}</span>
        </span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{window.percentText}</span>
      </div>
      <div
        style={{
          height: 4,
          borderRadius: 2,
          overflow: 'hidden',
          background: 'var(--dsw-alias-fill-tertiary, rgba(127, 127, 127, 0.25))',
        }}
      >
        <div style={{ width: barWidth(window.percentText), height: '100%', background: SEVERITY_COLOR[window.severity] }} />
      </div>
      <div style={{ fontSize: 11, color: MUTED }}>
        {window.limitReached ? 'limit reached · ' : ''}
        resets {window.resetsIn}
      </div>
    </div>
  )
}

/** The detail popover body. */
function Details({ view }: { view: UsageView }): ReactNode {
  if (view.kind === 'loading') {
    return <div style={{ ...TEXT, color: MUTED }}>Loading usage…</div>
  }

  if (view.kind === 'error') {
    return (
      <div style={{ display: 'grid', gap: 6, ...TEXT }}>
        <div>{view.message}</div>
        {view.status === undefined ? null : (
          <div style={{ fontSize: 11, color: MUTED }}>HTTP {view.status}</div>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 10, ...TEXT }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
          <SeverityDot severity={view.severity} />
          {view.label}
        </span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{view.percentText}</span>
      </div>
      <div style={{ fontSize: 11, color: MUTED }}>
        Updated {view.fetchedAtText}
        {view.stale ? ' · stale: the last provider read failed' : ''}
      </div>
      {view.windows.length === 0 ? (
        <div style={{ fontSize: 11, color: MUTED }}>No quota windows were reported.</div>
      ) : (
        view.windows.map((window) => <WindowRow key={window.id} window={window} />)
      )}
    </div>
  )
}

/**
 * The always-visible numbers.
 *
 * Expanded, all three windows share the row as `label percent` pairs: the
 * binding window's percentage alone hides the other two, and they matter — a
 * drained short window blocks work while the monthly window still has room.
 * In the 56px rail only the binding window's percentage fits beside the dot.
 */
function IndicatorNumbers({ view, wide }: { view: UsageOkView; wide: boolean }): ReactNode {
  if (!wide || view.windows.length === 0) {
    return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{view.percentText}</span>
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8, fontVariantNumeric: 'tabular-nums' }}>
      {view.windows.map((window) => (
        <span key={window.id} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 3 }}>
          <span style={{ color: MUTED, fontSize: 11 }}>{window.shortLabel}</span>
          <span style={{ color: window.severity === 'ok' ? 'inherit' : SEVERITY_COLOR[window.severity] }}>
            {window.percentText}
          </span>
        </span>
      ))}
    </span>
  )
}

/**
 * Sidebar-foot quota indicator.
 *
 * @param props - owner share `wide` plus optional fetch/clock/poll seams.
 * @returns the indicator button and, once opened, its popover.
 */
export function UsageIndicator({
  wide = true,
  fetchImpl,
  now,
  pollMs = DEFAULT_POLL_MS,
}: UsageIndicatorProps): ReactNode {
  const [read, setRead] = useState<UsageRead | undefined>(undefined)
  const [inFlight, setInFlight] = useState(false)
  const [open, setOpen] = useState(false)
  const [nowMs, setNowMs] = useState(() => (now ?? Date.now)())

  /**
   * Two refs guard the two ways a late response could corrupt the UI:
   * `mounted` (never write state after unmount) and `ticket` (out-of-order
   * responses: only the newest request may commit).
   */
  const mounted = useRef(true)
  const ticket = useRef(0)

  /** The button the popover is placed against. */
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [measured, setMeasured] = useState<PopoverPlacement | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const request = useCallback(
    async (method: 'GET' | 'POST'): Promise<void> => {
      const current = ticket.current + 1
      ticket.current = current
      setInFlight(true)
      try {
        const fetcher = fetchImpl ?? fetch
        const result = method === 'POST' ? await refreshUsage(fetcher, REFRESH_PATH) : await fetchUsage(fetcher, USAGE_PATH)
        if (!mounted.current || current !== ticket.current) return
        setRead(result)
      } finally {
        // Only the newest request clears its own spinner; a superseded one must
        // not re-enable a button whose request is still running.
        if (mounted.current && current === ticket.current) setInFlight(false)
      }
    },
    [fetchImpl],
  )

  /**
   * The ticking clock. `nowMs` is state, not a read of `Date.now` during render:
   * without a state change nothing would re-render, which is exactly the bug
   * that froze the countdown. Cleared on unmount (and on a clock-seam swap).
   */
  useEffect(() => {
    const readClock = now ?? Date.now
    setNowMs(readClock())
    const tick = setInterval(() => {
      setNowMs(readClock())
    }, TICK_MS)
    return () => {
      clearInterval(tick)
    }
  }, [now])

  /**
   * Initial load plus the bounded poll. One effect so the poll can never outlive
   * its own first read, and one cleanup that always stops it.
   */
  useEffect(() => {
    void request('GET')
    // Written as `!(pollMs > 0)` on purpose: a non-finite interval would be
    // coerced to 0 by `setInterval` and poll in a tight loop, so NaN must disable
    // polling too.
    if (!(pollMs > 0)) return undefined
    const poll = setInterval(() => {
      void request('GET')
    }, pollMs)
    return () => {
      clearInterval(poll)
    }
  }, [request, pollMs])

  /**
   * Popover placement.
   *
   * The panel is positioned `fixed` rather than `absolute` because its ancestor
   * column is `overflow: hidden` and only as wide as the column: anchored to a
   * button at the left of the full-width footer row, an absolutely positioned
   * panel grew off the left edge of the window and was clipped by the column.
   * `placePopover` clamps it into the viewport instead.
   *
   * `measure` is also read during render when nothing is stored yet, so the
   * first open paints in the right place instead of flashing at the origin; the
   * effect then keeps it fresh while the window resizes or anything scrolls.
   */
  const measure = useCallback((): PopoverPlacement | null => {
    const element = buttonRef.current
    if (element === null || typeof window === 'undefined') return null
    return placePopover(element.getBoundingClientRect(), {
      width: window.innerWidth,
      height: window.innerHeight,
    })
  }, [])

  useEffect(() => {
    if (!open) {
      setMeasured(null)
      return undefined
    }
    const sync = (): void => {
      setMeasured(measure())
    }
    sync()
    window.addEventListener('resize', sync)
    // Capture phase: the anchor can move when any scroll container moves, not
    // only when the window itself scrolls.
    window.addEventListener('scroll', sync, true)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [open, measure])

  const placement = open ? (measured ?? measure()) : null

  // Computed per render, from the ticking clock and the host's own age report,
  // so the countdown and the "updated … ago" line move as time passes.
  const view: UsageView = describeEnvelope(read?.envelope, nowMs, read?.serverAgeMs)

  // The accessible name carries every window the button shows, not only the
  // binding one: a screen reader gets the same reading a sighted user does.
  const accessibleName =
    view.kind === 'ok'
      ? `${view.label} usage: ${
          view.windows.length === 0
            ? view.percentText
            : view.windows.map((window) => `${window.label} ${window.percentText}`).join(', ')
        }${view.stale ? ' (stale)' : ''}`
      : view.kind === 'error'
        ? `Usage unavailable: ${view.message}`
        : 'Usage: loading'

  return (
    <span style={{ position: 'relative', display: 'inline-flex', ...TEXT }}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={accessibleName}
        aria-expanded={open}
        title={accessibleName}
        onClick={() => {
          setOpen((wasOpen) => !wasOpen)
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          minWidth: 28,
          height: 28,
          padding: wide ? '0 8px' : 0,
          border: 'none',
          borderRadius: 'var(--dsw-radius-sm, 6px)',
          background: open ? 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.18))' : 'transparent',
          color: 'inherit',
          font: 'inherit',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        <SeverityDot severity={view.kind === 'ok' ? view.severity : view.kind === 'error' ? 'critical' : 'ok'} />
        {view.kind === 'ok' ? <IndicatorNumbers view={view} wide={wide} /> : null}
      </button>

      {open && placement !== null ? (
        <div
          role="dialog"
          aria-label="Usage details"
          style={{
            // Fixed against the viewport, not the sidebar column: the column
            // clips its overflow and is narrower than this panel.
            position: 'fixed',
            left: placement.left,
            width: placement.width,
            ...(placement.side === 'above'
              ? { bottom: placement.bottom ?? 0 }
              : { top: placement.top ?? 0 }),
            zIndex: 1000,
            maxHeight: 'calc(100vh - 16px)',
            overflowY: 'auto',
            display: 'grid',
            gap: 10,
            padding: 12,
            border: `1px solid ${BORDER}`,
            borderRadius: 'var(--dsw-radius-md, 8px)',
            background: SURFACE,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
            fontSize: 12,
          }}
        >
          <Details view={view} />
          <button
            type="button"
            disabled={inFlight}
            onClick={() => {
              void request('POST')
            }}
            style={{
              justifySelf: 'end',
              padding: '4px 10px',
              border: `1px solid ${BORDER}`,
              borderRadius: 'var(--dsw-radius-sm, 6px)',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 12,
              cursor: inFlight ? 'default' : 'pointer',
              opacity: inFlight ? 0.6 : 1,
            }}
          >
            {inFlight ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      ) : null}
    </span>
  )
}
