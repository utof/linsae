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
  openPane: (paneId: string) => void
  closePane: (paneId: string) => void
  togglePane: (paneId: string) => void
  setActive: (side: DockSide, paneId: string) => void
  setWidth: (paneId: string, width: number) => void
  reset: () => void
}

const EMPTY = (): Pick<DockStore, 'left' | 'right' | 'widths'> => ({
  left: { openPaneIds: [], activeId: null },
  right: { openPaneIds: [], activeId: null },
  widths: {},
})

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
      return { ...withSlice(side, { openPaneIds, activeId: paneId }), widths }
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
  reset: () => set(EMPTY()),
}))

/**
 * The remembered width for a dock SIDE (B15): the per-side stored width, else the
 * utility default as a safe fallback (a side is always seeded on its first open,
 * so the fallback is only hit before any pane opens). Used by DockHost + App.
 * @see adrs/0047-feed-default-width-docks-fill-gutters.md
 */
export function dockWidthFor(state: DockStore, side: DockSide): number {
  return state.widths[side] ?? defaultWidthFor('utility')
}
