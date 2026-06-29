// src/renderer/src/panes/dockStore.ts
import { create } from 'zustand'
import { clampWidth, defaultWidthFor, type PaneKind } from './dock-widths'
import { getPane } from './Pane'

/**
 * Which side of the dock layout a pane lives on.
 * @see docs/specs/v0.6.2-dock-shell.md §1
 */
export type DockSide = 'left' | 'right'
interface DockSlice {
  openPaneIds: string[]
  activeId: string | null
}

interface DockStore {
  left: DockSlice
  right: DockSlice
  /**
   * Remembered width PER DOCK SIDE (B15): one width per `left`/`right`, NOT per
   * pane — so switching the active tab (pdf ↔ backlinks) never changes the dock's
   * width. Seeded on the first open of a side to that pane's kind default, updated
   * on resize (clamped to the resized pane's kind band), preserved verbatim across
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

/** The width band a pane belongs to (content panes get the wider band). Exported
 *  so callers computing the window-aware resize cap can size it to the active pane. */
export const paneKind = (paneId: string): PaneKind =>
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
      // Per-side width (B15), clamped to the RESIZED pane's kind band.
      return { widths: { ...s.widths, [side]: clampWidth(paneKind(paneId), width) } }
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
  reset: () => set(EMPTY()),
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
