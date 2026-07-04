// src/renderer/src/panes/dockStore.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { maxDockWidth } from './dock-widths'
import { dockKindFor, dockWidthFor, isSideShown, useDockStore } from './dockStore'
import type { Pane } from './Pane'
import * as PaneModule from './Pane'

const s = () => useDockStore.getState()
// Decouple the store test from the live registry: 'backlinks' isn't registered
// until Task 6, and the close-neighbor cases need TWO right-homing panes (the
// real registry has only 'pdf'). Spy getPane (the Dock.right.test.tsx idiom).
const FAKE: Record<string, Pick<Pane, 'homeDock' | 'kind'>> = {
  shelf: { homeDock: 'left', kind: 'utility' },
  pdf: { homeDock: 'right', kind: 'content' },
  backlinks: { homeDock: 'right', kind: 'utility' },
}
beforeEach(() => {
  s().reset()
  vi.spyOn(PaneModule, 'getPane').mockImplementation((id: string) =>
    FAKE[id] ? { id, title: id, render: () => null, ...FAKE[id] } : undefined,
  )
})
afterEach(() => vi.restoreAllMocks())

describe('dockStore', () => {
  it('openPane routes to the pane home dock and activates it', () => {
    s().openPane('shelf') // homeDock 'left'
    s().openPane('pdf') // homeDock 'right'
    expect(s().left).toEqual({ openPaneIds: ['shelf'], activeId: 'shelf' })
    expect(s().right).toEqual({ openPaneIds: ['pdf'], activeId: 'pdf' })
  })
  it('openPane is idempotent — re-open just re-activates, no dupes', () => {
    s().openPane('pdf')
    s().openPane('backlinks') // also 'right'
    s().openPane('pdf') // re-open
    expect(s().right.openPaneIds).toEqual(['pdf', 'backlinks'])
    expect(s().right.activeId).toBe('pdf')
  })
  it('openPane is a no-op for an unknown pane id', () => {
    s().openPane('nope')
    expect(s().left.openPaneIds).toEqual([])
    expect(s().right.openPaneIds).toEqual([])
  })
  it('closePane removes; active falls back to the left neighbor, else the next, else null', () => {
    s().openPane('pdf')
    s().openPane('backlinks')
    s().setActive('right', 'backlinks')
    s().closePane('backlinks') // active was last → left neighbor 'pdf'
    expect(s().right).toEqual({ openPaneIds: ['pdf'], activeId: 'pdf' })
    s().closePane('pdf') // empties the dock
    expect(s().right).toEqual({ openPaneIds: [], activeId: null })
  })
  it('closePane of the active first tab falls to the new first', () => {
    s().openPane('pdf')
    s().openPane('backlinks')
    s().setActive('right', 'pdf') // active is index 0
    s().closePane('pdf')
    expect(s().right).toEqual({ openPaneIds: ['backlinks'], activeId: 'backlinks' })
  })
  it('closePane of a non-active tab leaves the active id unchanged', () => {
    s().openPane('pdf')
    s().openPane('backlinks') // active is now 'backlinks'
    s().closePane('pdf') // close the NON-active first tab
    expect(s().right).toEqual({ openPaneIds: ['backlinks'], activeId: 'backlinks' })
  })
  it('togglePane opens then closes', () => {
    s().togglePane('shelf')
    expect(s().left.openPaneIds).toEqual(['shelf'])
    s().togglePane('shelf')
    expect(s().left).toEqual({ openPaneIds: [], activeId: null })
  })
  it('width is per dock SIDE: seeded on first open, preserved across tab switches (B15)', () => {
    s().openPane('pdf') // right, content → seed 600
    expect(s().widths.right).toBe(600)
    s().openPane('backlinks') // second right tab → width unchanged (not re-seeded)
    expect(s().widths.right).toBe(600)
    // Switching the active tab must NOT change the dock width.
    s().setActive('right', 'backlinks')
    expect(dockWidthFor(s(), 'right')).toBe(600)
    s().setActive('right', 'pdf')
    expect(dockWidthFor(s(), 'right')).toBe(600)
  })

  it('left side seeds its own width independently; utility default 280', () => {
    s().openPane('shelf') // left, utility → seed 280
    expect(s().widths.left).toBe(280)
    expect(s().right).toEqual({ openPaneIds: [], activeId: null })
    expect(s().widths.right).toBeUndefined()
  })

  it('setWidth writes per side, clamped to the DOCK kind band (widest resident pane); no-op if not open', () => {
    s().openPane('pdf') // right content
    s().setWidth('pdf', 9999) // dock kind content → max 900
    expect(s().widths.right).toBe(900)
    s().setWidth('shelf', 100) // shelf not open → sideHolding null → no-op
    expect(s().widths.left).toBeUndefined()
  })

  // The dock keeps ONE width across tab switches (B15), so its width band must derive
  // from the WIDEST resident pane — not the active tab. Regression guard for the
  // "dock shrinks when a utility tab (backlinks) is activated over a PDF" bug.
  // @see adrs/0047-feed-default-width-docks-fill-gutters.md
  describe('dockKindFor — width band from the widest resident pane, not the active tab', () => {
    it('is content when the side holds ANY content pane, regardless of the active tab', () => {
      s().openPane('pdf') // content
      s().openPane('backlinks') // utility → becomes active
      s().setActive('right', 'backlinks')
      expect(dockKindFor(s(), 'right')).toBe('content')
    })
    it('is utility for a utility-only side, and utility when the side is empty', () => {
      expect(dockKindFor(s(), 'right')).toBe('utility') // empty
      s().openPane('backlinks')
      expect(dockKindFor(s(), 'right')).toBe('utility')
    })
    it('composed with maxDockWidth: [pdf, backlinks] with backlinks active keeps the CONTENT max (900), not utility 400', () => {
      s().openPane('pdf')
      s().openPane('backlinks')
      s().setActive('right', 'backlinks')
      // Repro of the reported shrink: on a wide window the cap is the dock kind's max.
      // Active pane is utility (400) but the dock holds a PDF → content (900).
      expect(maxDockWidth(dockKindFor(s(), 'right'), 0, 2000)).toBe(900)
    })
    it('setWidth uses the dock kind: resizing while backlinks is active does NOT clamp to the utility band', () => {
      s().openPane('pdf') // seed 600
      s().openPane('backlinks')
      s().setActive('right', 'backlinks')
      s().setWidth('backlinks', 900) // active pane utility (max 400) but dock is content
      expect(s().widths.right).toBe(900) // kept in the content band, not clamped to 400
    })
  })

  it('dockWidthFor falls back to the utility default before any pane opens', () => {
    expect(dockWidthFor(s(), 'right')).toBe(280)
  })

  // B19: the top toggle collapses/restores a WHOLE side; a per-tab close is separate.
  describe('side collapse / restore (B19)', () => {
    it('toggleSide collapses a shown side, KEEPING its panes/active/width for restore', () => {
      s().openPane('pdf')
      s().openPane('backlinks') // right: [pdf, backlinks], active backlinks
      s().setWidth('pdf', 700) // per-side right width
      s().toggleSide('right') // shown → collapse
      expect(isSideShown(s(), 'right')).toBe(false)
      expect(s().right.openPaneIds).toEqual(['pdf', 'backlinks']) // panes preserved
      expect(s().right.activeId).toBe('backlinks') // active preserved
      expect(s().widths.right).toBe(700) // width preserved (B15 + B19)
    })
    it('toggleSide restores a collapsed side (panes + active intact)', () => {
      s().openPane('pdf')
      s().toggleSide('right') // collapse
      expect(isSideShown(s(), 'right')).toBe(false)
      s().toggleSide('right') // restore
      expect(isSideShown(s(), 'right')).toBe(true)
      expect(s().right.activeId).toBe('pdf')
    })
    it('toggleSide on a FRESH side opens its default pane (right→backlinks, left→shelf)', () => {
      s().toggleSide('right')
      expect(s().right.openPaneIds).toEqual(['backlinks'])
      expect(isSideShown(s(), 'right')).toBe(true)
      s().toggleSide('left')
      expect(s().left.openPaneIds).toEqual(['shelf'])
      expect(isSideShown(s(), 'left')).toBe(true)
    })
    it('openPane clears an explicit collapse so a new open re-reveals the side (B6/B19)', () => {
      s().openPane('backlinks')
      s().collapseSide('right')
      expect(isSideShown(s(), 'right')).toBe(false)
      s().openPane('backlinks') // re-open → reveals
      expect(isSideShown(s(), 'right')).toBe(true)
    })
    it('collapse is per side and symmetric: collapsing right leaves left shown', () => {
      s().openPane('shelf') // left
      s().openPane('pdf') // right
      s().collapseSide('right')
      expect(isSideShown(s(), 'left')).toBe(true)
      expect(isSideShown(s(), 'right')).toBe(false)
      s().collapseSide('left')
      expect(isSideShown(s(), 'left')).toBe(false)
    })
  })
})
