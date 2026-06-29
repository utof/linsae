// src/renderer/src/panes/dockStore.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dockWidthFor, useDockStore } from './dockStore'
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

  it('setWidth writes per side, clamped to the RESIZED pane kind band; no-op if not open', () => {
    s().openPane('pdf') // right content
    s().setWidth('pdf', 9999) // content max 900
    expect(s().widths.right).toBe(900)
    s().setWidth('shelf', 100) // shelf not open → sideHolding null → no-op
    expect(s().widths.left).toBeUndefined()
  })

  it('dockWidthFor falls back to the utility default before any pane opens', () => {
    expect(dockWidthFor(s(), 'right')).toBe(280)
  })
})
