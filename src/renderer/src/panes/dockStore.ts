// src/renderer/src/panes/dockStore.ts
import { create } from 'zustand'
import { clampWidth, defaultWidthFor, type PaneKind } from './dock-widths'
import { getPane } from './Pane'

/**
 * Which side of the dock layout a pane lives on.
 * @see docs/specs/v0.6.2-dock-shell.md §1
 */
export type DockSide = 'left' | 'right'
export interface DockSlice {
  openPaneIds: string[]
  activeId: string | null
}

/**
 * The four persisted dock fields — structurally matches `z.infer<typeof DockLayoutV1Schema>`
 * (`src/shared/zod-schemas.ts`): two slices plus partial per-side width/collapse maps. The
 * debounced persist subscriber emits this shape; `hydrate` consumes it at boot.
 * @see docs/specs/v0.7-session-persistence.md
 */
export interface SerializedDock {
  left: DockSlice
  right: DockSlice
  widths: Partial<Record<DockSide, number>>
  collapsed: Partial<Record<DockSide, boolean>>
}

interface DockStore {
  left: DockSlice
  right: DockSlice
  /**
   * Remembered width PER DOCK SIDE (B15): one width per `left`/`right`, NOT per
   * pane — so switching the active tab (pdf ↔ backlinks) never changes the dock's
   * width. Seeded on the first open of a side to that pane's kind default, updated
   * on resize (clamped to the dock's kind band — the widest resident pane, so a
   * content pane keeps the wide band under a utility tab), preserved verbatim across
   * active-tab changes. @see adrs/0047-feed-default-width-docks-fill-gutters.md
   */
  widths: Partial<Record<DockSide, number>>
  /**
   * Per-side EXPLICIT-collapse flag (B19). The top side-panel toggle collapses a
   * whole side: `openPaneIds`/`activeId`/width are kept intact (so a later expand
   * restores exactly what was there) but the side renders nothing and contributes 0
   * to the feed-width cap. Distinct from closing a tab (which removes a pane).
   * @see adrs/0047-feed-default-width-docks-fill-gutters.md
   */
  collapsed: Partial<Record<DockSide, boolean>>
  openPane: (paneId: string) => void
  closePane: (paneId: string) => void
  togglePane: (paneId: string) => void
  setActive: (side: DockSide, paneId: string) => void
  setWidth: (paneId: string, width: number) => void
  /** Collapse a whole side, remembering its panes/active/width (B19). */
  collapseSide: (side: DockSide) => void
  /** Expand a side: restore its remembered panes, or open the side default if fresh (B19). */
  expandSide: (side: DockSide) => void
  /** Top side-panel toggle (B19): shown → collapse; collapsed/empty → expand/restore. */
  toggleSide: (side: DockSide) => void
  /**
   * True once a persisted layout (or the no-saved-layout default in Task 1.6) has been
   * applied at boot. The persist subscriber ignores all pre-hydrate churn AND the hydrate
   * transition itself, writing only genuine post-boot changes. @see subscribeDockPersist
   */
  hydrated: boolean
  /**
   * Apply a persisted layout at boot: DROP content-kind panes (a pdf/player re-opens from
   * its media context, never from a restored id list, so restore must never yield an empty
   * content pane), re-point each side's active to a surviving pane, and clamp restored
   * widths to the utility band. Sets `hydrated`. @see docs/specs/v0.7-session-persistence.md
   */
  hydrate: (snap: SerializedDock) => void
  reset: () => void
}

const EMPTY = (): Pick<DockStore, 'left' | 'right' | 'widths' | 'collapsed'> => ({
  left: { openPaneIds: [], activeId: null },
  right: { openPaneIds: [], activeId: null },
  widths: {},
  collapsed: {},
})

/** The pane a fresh (never-opened) side opens when its toggle is first pressed
 *  (B19): right defaults to backlinks (matching the prior B2 toggle), left to shelf. */
const DEFAULT_PANE: Record<DockSide, string> = { left: 'shelf', right: 'backlinks' }

/** The width band a single pane belongs to (content panes get the wider band).
 *  Module-local: dock-level sizing goes through `dockKindFor` (widest resident pane),
 *  which callers use to size the window-aware resize cap. */
const paneKind = (paneId: string): PaneKind =>
  getPane(paneId)?.kind === 'content' ? 'content' : 'utility'

const withSlice = (side: DockSide, slice: DockSlice): Partial<DockStore> =>
  side === 'left' ? { left: slice } : { right: slice }

const sideHolding = (s: DockStore, paneId: string): DockSide | null =>
  s.left.openPaneIds.includes(paneId)
    ? 'left'
    : s.right.openPaneIds.includes(paneId)
      ? 'right'
      : null

/**
 * Zustand store for the dock shell — two docks (`left`, `right`), each holding
 * an ordered list of open pane ids and an active id, plus per-pane remembered
 * widths (clamped to the pane's kind band via `clampWidth`).
 * @see docs/specs/v0.6.2-dock-shell.md §1
 */
export const useDockStore = create<DockStore>()((set, get) => ({
  ...EMPTY(),
  hydrated: false,
  openPane: (paneId) => {
    const pane = getPane(paneId)
    if (!pane) return
    const side = pane.homeDock
    set((s) => {
      const slice = s[side]
      const openPaneIds = slice.openPaneIds.includes(paneId)
        ? slice.openPaneIds
        : [...slice.openPaneIds, paneId]
      // Seed the per-side width on the FIRST open of this side (B15); later opens
      // (a second tab) leave it untouched so the width is preserved across tabs.
      const widths =
        s.widths[side] === undefined
          ? { ...s.widths, [side]: defaultWidthFor(paneKind(paneId)) }
          : s.widths
      // Opening a pane REVEALS the side, clearing any explicit collapse (B19). This
      // is what lets the focus→backlinks auto-open re-show a collapsed dock when the
      // user focuses a DIFFERENT note (the [focusedId] effect calls openPane).
      const collapsed = s.collapsed[side] ? { ...s.collapsed, [side]: false } : s.collapsed
      return { ...withSlice(side, { openPaneIds, activeId: paneId }), widths, collapsed }
    })
  },
  closePane: (paneId) => {
    const side = sideHolding(get(), paneId)
    if (!side) return
    set((s) => {
      const slice = s[side]
      const idx = slice.openPaneIds.indexOf(paneId)
      const openPaneIds = slice.openPaneIds.filter((id) => id !== paneId)
      // active falls back to the left neighbor, else the one shifted into its slot, else null
      const activeId =
        slice.activeId === paneId
          ? (openPaneIds[idx - 1] ?? openPaneIds[idx] ?? null)
          : slice.activeId
      return withSlice(side, { openPaneIds, activeId })
    })
  },
  togglePane: (paneId) => {
    if (sideHolding(get(), paneId)) get().closePane(paneId)
    else get().openPane(paneId)
  },
  setActive: (side, paneId) => set((s) => withSlice(side, { ...s[side], activeId: paneId })),
  setWidth: (paneId, width) =>
    set((s) => {
      const side = sideHolding(s, paneId)
      if (!side) return {}
      // Per-side width (B15), clamped to the DOCK's kind band (the widest resident
      // pane), NOT the resized/active pane's kind — so resizing while a narrow utility
      // tab (backlinks, max 400) is active over a content pane (PDF, max 900) can't
      // shrink the dock below the content band. Mirror of the tab-switch fix.
      return { widths: { ...s.widths, [side]: clampWidth(dockKindFor(s, side), width) } }
    }),
  collapseSide: (side) => set((s) => ({ collapsed: { ...s.collapsed, [side]: true } })),
  expandSide: (side) => {
    // Restore the remembered panes if any; a fresh side opens its default pane
    // (openPane also clears the collapse flag). Restoring re-applies the remembered
    // per-side width within the current window cap (App's dockGeom does that).
    if (get()[side].openPaneIds.length > 0) {
      set((s) => ({ collapsed: { ...s.collapsed, [side]: false } }))
    } else {
      get().openPane(DEFAULT_PANE[side])
    }
  },
  toggleSide: (side) => {
    if (isSideShown(get(), side)) get().collapseSide(side)
    else get().expandSide(side)
  },
  hydrate: (snap) =>
    set(() => {
      const filterSide = (sl: DockSlice) => {
        const ids = sl.openPaneIds.filter((id) => getPane(id) != null && paneKind(id) === 'utility')
        const activeId = ids.includes(sl.activeId ?? '') ? sl.activeId : (ids[0] ?? null)
        return { openPaneIds: ids, activeId }
      }
      const widths: Partial<Record<DockSide, number>> = {}
      for (const side of ['left', 'right'] as const) {
        const w = snap.widths[side]
        // content panes are filtered out above, so a restored dock is always utility-kind
        // here — clamp to the utility band directly (no dockKindFor needed).
        if (w != null) widths[side] = clampWidth('utility', w)
      }
      return {
        left: filterSide(snap.left),
        right: filterSide(snap.right),
        widths,
        collapsed: snap.collapsed,
        hydrated: true,
      }
    }),
  // Test-only: also clears `hydrated` so a suite that hydrated in a prior test starts
  // this one pre-hydrate (the persist subscriber's transition guard depends on it).
  reset: () => set({ ...EMPTY(), hydrated: false }),
}))

/**
 * Whether a dock side is currently VISIBLE: it has an active pane AND is not
 * explicitly collapsed (B19). Drives the dock render, the toggle pressed-state, and
 * the feed-width geometry (a hidden side contributes 0 width).
 * @see adrs/0047-feed-default-width-docks-fill-gutters.md
 */
export function isSideShown(state: DockStore, side: DockSide): boolean {
  return state[side].activeId != null && !state.collapsed[side]
}

/**
 * The remembered width for a dock SIDE (B15): the per-side stored width, else the
 * utility default as a safe fallback (a side is always seeded on its first open,
 * so the fallback is only hit before any pane opens). Used by DockHost + App.
 * @see adrs/0047-feed-default-width-docks-fill-gutters.md
 */
export function dockWidthFor(state: DockStore, side: DockSide): number {
  return state.widths[side] ?? defaultWidthFor('utility')
}

/**
 * The width band a dock SIDE renders at: the kind of its WIDEST resident pane —
 * `content` if the side holds ANY content pane (a PDF/player), else `utility`
 * (empty sides read as `utility`).
 *
 * Why widest-not-active: a dock keeps ONE width across tab switches (B15). If the
 * render bounds followed the ACTIVE pane's kind, activating a narrow-band utility
 * tab (backlinks, max 400) over a content pane (PDF, max 900) would clamp the
 * user's chosen width down — the dock would visibly shrink on a mere tab switch.
 * Deriving the band from the widest resident pane keeps the width stable; only the
 * user's drag (via `setWidth`, clamped to this same kind) changes it.
 * @see adrs/0047-feed-default-width-docks-fill-gutters.md
 */
export function dockKindFor(state: DockStore, side: DockSide): PaneKind {
  return state[side].openPaneIds.some((id) => paneKind(id) === 'content') ? 'content' : 'utility'
}

/**
 * Subscribe a debounced persister to dock changes; SKIPS the hydrate transition
 * (prev.hydrated=false → s.hydrated=true) so the just-restored layout is never echoed, then
 * writes every later change. NOTE: zustand v5 `subscribe` passes (state, prevState) with a
 * FRESH state object each `set`, so `s === prev` is never true — we latch on the `hydrated`
 * transition, not on reference equality. Returns an unsubscribe fn.
 * @see docs/specs/v0.7-session-persistence.md
 */
export function subscribeDockPersist(write: (snap: SerializedDock) => void, debounceMs = 400) {
  let timer: ReturnType<typeof setTimeout> | undefined
  // The latest debounced-but-unwritten snapshot, so `visibilitychange`→hidden can
  // flush it immediately (spec §Write-through: hidden is authoritative). Nulled on
  // either write path so the flush and the timer never double-write.
  let pending: SerializedDock | null = null
  const flush = () => {
    if (!document.hidden || pending == null) return
    clearTimeout(timer)
    const snap = pending
    pending = null
    write(snap)
  }
  const unsub = useDockStore.subscribe((s, prev) => {
    if (!s.hydrated) return // pre-hydrate changes ignored
    if (!prev.hydrated) return // THIS call is the hydrate transition itself — don't echo it
    const snap: SerializedDock = {
      left: s.left,
      right: s.right,
      widths: s.widths,
      collapsed: s.collapsed,
    }
    pending = snap
    clearTimeout(timer)
    timer = setTimeout(() => {
      pending = null
      write(snap)
    }, debounceMs)
  })
  // Mirror usePersistedWrite's last-chance flush (usePersistedWrite.ts): the debounce
  // can otherwise silently lose a resize/toggle made just before Cmd-Q.
  document.addEventListener('visibilitychange', flush)
  // Clear any scheduled debounce AND remove the flush listener on teardown so a pending
  // write() never fires after unsub (redundant write / cross-test timer bleed).
  return () => {
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', flush)
    unsub()
  }
}
