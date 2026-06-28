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
  widths: Record<string, number>
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

const kindOf = (paneId: string): PaneKind =>
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
      return withSlice(side, { openPaneIds, activeId: paneId })
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
    set((s) => ({ widths: { ...s.widths, [paneId]: clampWidth(kindOf(paneId), width) } })),
  reset: () => set(EMPTY()),
}))

/**
 * Active-pane width: remembered width, else the kind default. Used by DockHost.
 * @see docs/specs/v0.6.2-dock-shell.md §1
 */
export function dockWidthFor(state: DockStore, paneId: string): number {
  return state.widths[paneId] ?? defaultWidthFor(kindOf(paneId))
}
