import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DockHost } from './DockHost'
import { useDockStore } from './dockStore'
import * as PaneModule from './Pane'

beforeEach(() => {
  useDockStore.getState().reset()
  vi.spyOn(PaneModule, 'getPane').mockImplementation((id: string) => ({
    id,
    title: id,
    homeDock: id === 'shelf' ? 'left' : 'right',
    kind: id === 'pdf' ? 'content' : 'utility',
    render: () => <div>{id} body</div>,
  }))
})
afterEach(() => vi.restoreAllMocks())

describe('DockHost', () => {
  it('renders null when its side is empty', () => {
    const { container } = render(<DockHost side="right" onPaneClose={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })
  it('renders the dock when a pane is open', () => {
    useDockStore.getState().openPane('shelf') // left (FAKE homeDock)
    render(<DockHost side="left" onPaneClose={vi.fn()} />)
    expect(screen.getByText('shelf body')).toBeInTheDocument()
  })
  it('width flows from the store to the rendered dock', () => {
    useDockStore.getState().openPane('shelf') // left, utility default 280
    useDockStore.getState().setWidth('shelf', 320)
    const { container } = render(<DockHost side="left" onPaneClose={vi.fn()} />)
    expect((container.querySelector('[data-dock="left"]') as HTMLElement).style.width).toBe('320px')
  })
  it('resize drag keeps tracking past the first pointermove (drives the store)', () => {
    // Regression guard: the controlled `onWidthChange` is a fresh closure each
    // render and setWidth re-renders DockHost mid-drag. If Dock's drag handlers
    // tracked that identity, the unmount-safety effect would tear the window
    // listeners down after the first move — freezing the drag. This proves the
    // SECOND move still registers (width reflects clientX=560 → 340, not 300).
    useDockStore.getState().openPane('shelf') // left, utility default 280
    const { container } = render(<DockHost side="left" onPaneClose={vi.fn()} />)
    const handle = container.querySelector('[data-dock-resize]') as HTMLElement
    fireEvent.pointerDown(handle, { clientX: 500 }) // startWidth 280
    fireEvent.pointerMove(window, { clientX: 520 }) // +20 → 300
    fireEvent.pointerMove(window, { clientX: 560 }) // +60 → 340 (second move MUST register)
    fireEvent.pointerUp(window)
    expect(useDockStore.getState().widths.shelf).toBe(340)
  })
})
