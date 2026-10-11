/**
 * Browser half of `dsh-opencode-go-usage`.
 *
 * Loaded by DSH's browser module facade from the wrapped `lib/client.js` bundle
 * (see `scripts/wrap-client.mjs`). The only modules this half may `require` are
 * the platform-baseline ones (`react`, `react/jsx-runtime`), which is why the
 * build externalises exactly those two. The `@deepseek-ai/*` imports below are
 * therefore **type-only**: they are erased at build time and exist purely to type
 * this registration against the installed contracts, so a slot-contract change
 * in a future DSH fails `pnpm run typecheck` instead of activating a broken
 * widget — the drift guard PLAN.md §4 and docs/testing.md promise.
 *
 * `SlotCore['register']` is the real registration signature (`SlotRegistry`
 * reuses it verbatim, "one authority, no structural copy"), and the sidebar's
 * client entry supplies the `declare module` augmentation that puts
 * `sidebar.footer.action` into `SlotMap`.
 */
import type { SlotCore, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { UsageIndicator, type UsageIndicatorProps } from './UsageIndicator.js'

/** Service the browser half needs to register into a slot. */
export const inject = ['slots']

/** Registration id: the package name, so a diagnostic names the owner. */
const PLUGIN_ID = 'dsh-opencode-go-usage'
/** The declared list slot at the sidebar foot (`SidebarFooterActionOwnerProps`). */
const SLOT = 'sidebar.footer.action'
/** Ascending list order; leaves room for occupants ordered before and after. */
const ORDER = 100

/**
 * Compile-time check that the widget still accepts the owner share the sidebar
 * hands to a `sidebar.footer.action` occupant.
 *
 * The `register` call below already pins the slot key and its `kind` against the
 * installed `SlotMap`; this assertion covers the other axis, the component's
 * props. It is needed because every prop of {@link UsageIndicatorProps} is
 * optional, so a renamed or retyped owner field would otherwise be absorbed
 * silently. Inverted by design: a `false` argument violates `T extends true`.
 */
type Expect<T extends true> = T
type _FooterActionOwnerShareAccepted = Expect<
  SidebarFooterActionOwnerProps extends UsageIndicatorProps ? true : false
>

/** The slice of the client plugin context this half uses. */
interface ClientContext {
  slots: {
    /** The installed registry's own registration signature (both core overloads). */
    register: SlotCore['register']
    /**
     * The installed registry's declaration waiter, narrowed to the synchronous
     * disposer this half returns. Its key domain is the merged `SlotMap`, so an
     * unknown slot name is a type error here.
     */
    inject: (key: keyof SlotMap & string, callback: () => () => void) => () => void
  }
}

/**
 * Cordis entry point for the browser half.
 *
 * Registers {@link UsageIndicator} into `sidebar.footer.action` through
 * `ctx.slots.inject`, which is the installed API's declaration-aware doorway:
 * the callback runs as soon as (or as late as) `ui-sidebar` declares the slot,
 * and it re-runs if the declaration collapses and returns. That matters because
 * plugin load order is the loader's business, and a bare `register` into a
 * not-yet-declared slot throws at activation.
 *
 * Disposal: `SlotRegistry.register` is a prototype method whose cordis service
 * proxy binds `this.ctx` to the caller's fiber, so the entry is disposed on
 * plugin unload; `inject` adds its own fiber-owned, idempotent wait disposer on
 * top. No `ctx.effect` wrapper is needed — wrapping would register the same
 * lifetime twice for no gain.
 *
 * @param ctx - the client plugin context (injects `slots`).
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject(SLOT, () =>
    ctx.slots.register(
      { name: SLOT, id: PLUGIN_ID, order: ORDER, label: 'OpenCode Go usage' },
      UsageIndicator,
    ),
  )
}
