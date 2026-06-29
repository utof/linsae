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
  it('setWidth clamps per kind; dockWidthFor falls back to the kind default', () => {
    s().setWidth('shelf', 9999) // utility → 400
    s().setWidth('pdf', 100) // content → 400
    expect(s().widths.shelf).toBe(400)
    expect(s().widths.pdf).toBe(400)
    expect(dockWidthFor(s(), 'pdf')).toBe(400)
    expect(dockWidthFor(s(), 'backlinks')).toBe(280) // unset → utility default
  })
})
