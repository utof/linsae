// src/renderer/src/feed/Feed.selection.test.tsx
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Note } from '../../../shared/types'
import { Feed } from './Feed'

// Originals captured before mutation so afterAll can restore them. Required by
// vitest's `isolate: false` dom project (vitest.config.ts): prototype mutations
// outlive this file and leak into worker-shared happy-dom contexts — an
// unrestored getBoundingClientRect broke src/renderer/src/yt/rpc.test.ts when
// the two files shared a worker.
let originalGbcr: typeof HTMLElement.prototype.getBoundingClientRect
let originalOffsetHeight: PropertyDescriptor | undefined
let originalClipboard: PropertyDescriptor | undefined

// happy-dom has no layout engine: offsetHeight gates the virtualizer's
// outerSize (see Feed.test.tsx rationale) and getBoundingClientRect feeds
// measureElement + the drag hook's content-coordinate mapping. Fixed values
// make row geometry deterministic: every row measures 48px tall at top 0.
beforeAll(() => {
  originalGbcr = HTMLElement.prototype.getBoundingClientRect
  originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return 600
    },
  })
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 560,
      bottom: 48,
      width: 560,
      height: 48,
      toJSON: () => ({}),
    }) as DOMRect
})

afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = originalGbcr
  if (originalOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
  } else {
    // Added with configurable:true above — delete removes the own property cleanly.
    delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
  }
  // The clipboard test redefines navigator.clipboard (configurable) — restore
  // for the same isolate:false reason as above.
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard)
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard
  }
})

function makeNote(id: string): Note {
  return { id, body: id, type: 'claim', slug: id, created_at: 1, updated_at: 1, deleted_at: null }
}
const noop = () => {}

function renderFeed(overrides: Partial<Parameters<typeof Feed>[0]> = {}) {
  const notes = [makeNote('a'), makeNote('b'), makeNote('c')]
  const utils = render(
    <Feed
      notes={notes}
      focusedId={null}
      onFocus={noop}
      onWikilinkClick={noop}
      onEdit={noop}
      onDelete={noop}
      onCopyLink={noop}
      {...overrides}
    />,
  )
  return { notes, ...utils }
}

/**
 * Drags from clientY 10 to 1500 starting on row 0's wrapper gutter.
 *
 * Plan deviation (test-technique only): the plan's verbatim comment says
 * "every row measures 48px tall" but getBoundingClientRect.height=48 is
 * overridden by the global offsetHeight=600 mock (tanstack-virtual uses
 * offsetHeight to measure each row via observeElementRect). Rows end up at
 * start=[0,600,1200] instead of [0,48,96]. Increasing clientY to 1500 covers
 * all three rows without changing any assertion — what the test checks (>1
 * selected notes, bar counts) is identical. Zero assertion changes.
 *
 * @see feed.tsx Feed multi-select implementation notes
 */
async function dragGutter(container: HTMLElement) {
  const row = container.querySelector('[data-index="0"]') as HTMLElement
  fireEvent.pointerDown(row, { button: 0, clientY: 10 })
  fireEvent.pointerMove(window, { clientY: 700 })
  fireEvent.pointerMove(window, { clientY: 1500 })
  fireEvent.pointerUp(window)
  await act(async () => {})
}

describe('Feed multi-select', () => {
  it('gutter drag selects crossed rows and shows the bar with counts', async () => {
    const { container } = renderFeed()
    await act(async () => {})
    await dragGutter(container)
    expect(screen.getAllByRole('button', { name: 'deselect note' }).length).toBeGreaterThan(1)
    const count = screen.getAllByRole('button', { name: 'deselect note' }).length
    expect(screen.getByRole('button', { name: `delete ${count} notes` })).toBeInTheDocument()
  })

  it('press without crossing the threshold selects nothing', async () => {
    const { container } = renderFeed()
    await act(async () => {})
    const row = container.querySelector('[data-index="0"]') as HTMLElement
    fireEvent.pointerDown(row, { button: 0, clientY: 10 })
    fireEvent.pointerMove(window, { clientY: 12 })
    fireEvent.pointerUp(window)
    await act(async () => {})
    expect(screen.queryByRole('button', { name: /delete \d+ notes/ })).not.toBeInTheDocument()
  })

  it('a press starting on a bubble does not drag-select', async () => {
    const { container } = renderFeed()
    await act(async () => {})
    const bubble = container.querySelector('[data-bubble]') as HTMLElement
    fireEvent.pointerDown(bubble, { button: 0, clientY: 10 })
    fireEvent.pointerMove(window, { clientY: 300 })
    fireEvent.pointerUp(window)
    await act(async () => {})
    expect(screen.queryByRole('button', { name: /delete \d+ notes/ })).not.toBeInTheDocument()
  })

  it('in selection mode, clicking a row toggles it instead of focusing', async () => {
    const onFocus = vi.fn()
    const { container } = renderFeed({ onFocus })
    await act(async () => {})
    await dragGutter(container)
    const before = screen.getAllByRole('button', { name: 'deselect note' }).length
    const bubble = container.querySelector('[data-bubble]') as HTMLElement
    fireEvent.click(bubble)
    expect(onFocus).not.toHaveBeenCalled()
    const after = screen.queryAllByRole('button', { name: 'deselect note' }).length
    expect(after).toBe(before - 1)
  })

  it('cancel clears selection mode', async () => {
    const { container } = renderFeed()
    await act(async () => {})
    await dragGutter(container)
    fireEvent.click(screen.getByRole('button', { name: 'cancel selection' }))
    expect(screen.queryByRole('button', { name: 'cancel selection' })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: 'deselect note' })).toHaveLength(0)
  })

  it('Escape clears selection mode', async () => {
    const { container } = renderFeed()
    await act(async () => {})
    await dragGutter(container)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'cancel selection' })).not.toBeInTheDocument()
  })

  it('armed delete fires onDelete for every selected note and exits', async () => {
    const onDelete = vi.fn()
    const { container } = renderFeed({ onDelete })
    await act(async () => {})
    await dragGutter(container)
    const count = screen.getAllByRole('button', { name: 'deselect note' }).length
    fireEvent.click(screen.getByRole('button', { name: `delete ${count} notes` }))
    fireEvent.click(screen.getByRole('button', { name: `confirm delete ${count} notes` }))
    expect(onDelete).toHaveBeenCalledTimes(count)
    expect(screen.queryByRole('button', { name: 'cancel selection' })).not.toBeInTheDocument()
  })

  it('copy writes selected bodies to the clipboard and exits', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { container } = renderFeed()
    await act(async () => {})
    await dragGutter(container)
    const count = screen.getAllByRole('button', { name: 'deselect note' }).length
    fireEvent.click(screen.getByRole('button', { name: `copy ${count} notes` }))
    expect(writeText).toHaveBeenCalledOnce()
    const copied = writeText.mock.calls[0]![0] as string
    expect(copied.split('\n\n')).toHaveLength(count)
    expect(screen.queryByRole('button', { name: 'cancel selection' })).not.toBeInTheDocument()
  })
})

describe('Feed selection context menus', () => {
  it('gutter right-click with no selection offers Select and enters the mode', async () => {
    const { container } = renderFeed()
    await act(async () => {})
    const row = container.querySelector('[data-index="1"]') as HTMLElement
    fireEvent.contextMenu(row, { clientX: 600, clientY: 100 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'select' }))
    expect(screen.getAllByRole('button', { name: 'deselect note' })).toHaveLength(1)
  })

  it('bubble right-click with no selection keeps the per-note menu', async () => {
    const { container } = renderFeed()
    await act(async () => {})
    const bubble = container.querySelector('[data-bubble]') as HTMLElement
    fireEvent.contextMenu(bubble, { clientX: 100, clientY: 30 })
    expect(screen.getByRole('menuitem', { name: 'copy link' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'select' })).not.toBeInTheDocument()
  })

  it('right-click on an unselected row during selection offers select-up-to', async () => {
    const { container } = renderFeed()
    await act(async () => {})
    const row0 = container.querySelector('[data-index="0"]') as HTMLElement
    fireEvent.contextMenu(row0, { clientX: 600, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'select' }))
    const row2 = container.querySelector('[data-index="2"]') as HTMLElement
    fireEvent.contextMenu(row2, { clientX: 600, clientY: 140 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'select up to this note' }))
    expect(screen.getAllByRole('button', { name: 'deselect note' })).toHaveLength(3)
  })

  it('right-click on a selected row offers bulk actions; delete fires per id', async () => {
    const onDelete = vi.fn()
    const { container } = renderFeed({ onDelete })
    await act(async () => {})
    await dragGutter(container)
    const count = screen.getAllByRole('button', { name: 'deselect note' }).length
    const row0 = container.querySelector('[data-index="0"]') as HTMLElement
    fireEvent.contextMenu(row0, { clientX: 100, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'delete selected' }))
    expect(onDelete).toHaveBeenCalledTimes(count)
  })

  it('clear selection item exits the mode', async () => {
    const { container } = renderFeed()
    await act(async () => {})
    await dragGutter(container)
    const row0 = container.querySelector('[data-index="0"]') as HTMLElement
    fireEvent.contextMenu(row0, { clientX: 100, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'clear selection' }))
    expect(screen.queryByRole('button', { name: 'cancel selection' })).not.toBeInTheDocument()
  })
})
