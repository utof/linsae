import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { installMockApi, renderWithProviders } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'
import { formatDayLabel } from '../lib/day'

type ReactVirtualModule = typeof import('@tanstack/react-virtual')

// Pass-through mock of `useVirtualizer` that captures the REAL virtualizer instance so the
// v0.7 restore tests can assert on the seed options it received. The virtualizer's methods
// (scrollToIndex / takeSnapshot / setOptions) are per-instance arrow properties assigned in
// its constructor — NOT on the prototype — so prototype-spying is impossible; capturing the
// live instance and reading `.options` is the observable seam. Delegating to the real
// `useVirtualizer` keeps every other Feed test (which render real virtual items) unchanged.
const virtualMock = vi.hoisted(() => ({ latest: null as unknown }))
vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<ReactVirtualModule>()
  const useVirtualizer = ((options: Parameters<ReactVirtualModule['useVirtualizer']>[0]) => {
    const v = actual.useVirtualizer(options)
    virtualMock.latest = v
    return v
  }) as ReactVirtualModule['useVirtualizer']
  return { ...actual, useVirtualizer }
})

import { Feed } from './Feed'

// Original descriptor captured before mutation so afterAll can restore it.
// Required by vitest's `isolate: false` dom project (vitest.config.ts):
// prototype mutations outlive this file and leak into worker-shared happy-dom
// contexts (same leak shape that broke yt/rpc.test.ts via Feed.selection.test.tsx).
let originalOffsetHeight: PropertyDescriptor | undefined

// jsdom has no layout engine so offsetHeight is always 0.
// @tanstack/react-virtual's observeElementRect reads offsetHeight for getSize(),
// which gates getVirtualItems() on outerSize > 0. Without a non-zero size the
// virtualizer renders no items and NoteBubble is never mounted.
beforeAll(() => {
  originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return 600
    },
  })
})

afterAll(() => {
  if (originalOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
  } else {
    // Added with configurable:true above — delete removes the own property cleanly.
    delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
  }
})

function makeNote(id: string, body: string): Note {
  return { id, body, type: 'claim', slug: id, created_at: 1, updated_at: 1, deleted_at: null }
}
function makeSourceNote(id: string, videoId: string): Note {
  return {
    id,
    body: '',
    type: 'source',
    slug: id,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    source_kind: 'youtube',
    source_locator: { media: 'youtube', video_id: videoId },
  }
}
const noop = () => {}

describe('Feed onOpenThread wiring', () => {
  it('threads onOpenThread to the source bubble affordance', async () => {
    const api = installMockApi()
    api.videoSources.get.mockResolvedValue({
      title: 'Rick Roll',
      channel: 'Rick Astley',
      thumbnailUrl: null,
      durationSec: null,
    })
    api.links.commentsOf.mockResolvedValue([])
    const onOpenThread = vi.fn()
    const notes = [makeSourceNote('s1', 'dQw4w9WgXcQ')]
    renderWithProviders(
      <Feed
        notes={notes}
        focusedId={null}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
        onOpenThread={onOpenThread}
      />,
    )
    await act(async () => {})
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /open video notes/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: /open video notes/i }))
    expect(onOpenThread).toHaveBeenCalledWith('s1')
  })
})

describe('Feed date dividers', () => {
  // Fixed 2024 dates so the labels are stable month/day strings (never today/yesterday).
  const day1 = new Date(2024, 0, 15, 9, 0, 0).getTime()
  const day1Later = new Date(2024, 0, 15, 18, 0, 0).getTime()
  const day2 = new Date(2024, 0, 16, 10, 0, 0).getTime()
  const at = (id: string, ms: number): Note => ({
    ...makeNote(id, id),
    created_at: ms,
    updated_at: ms,
  })

  it('renders an inline date divider above the first note of each calendar day', async () => {
    render(
      <Feed
        notes={[at('a', day1), at('b', day2)]}
        focusedId={null}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    await act(async () => {})
    expect(screen.getByText(formatDayLabel(day1))).toBeInTheDocument()
    expect(screen.getByText(formatDayLabel(day2))).toBeInTheDocument()
  })

  it('groups same-day notes under a single divider', async () => {
    render(
      <Feed
        notes={[at('a', day1), at('b', day1Later)]}
        focusedId={null}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    await act(async () => {})
    // day1 and day1Later share a day → exactly one divider with that label.
    expect(screen.getAllByText(formatDayLabel(day1))).toHaveLength(1)
  })
})

describe('Feed expand/collapse state', () => {
  it('toggles a bubble between truncated and expanded affordances on click', async () => {
    const notes = [makeNote('n1', 'x'.repeat(5000))]
    render(
      <Feed
        notes={notes}
        focusedId={null}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    // RTL wraps render in act, but state update from the ref callback
    // (setScrollerEl) causes a re-render that must settle before the
    // virtualizer can compute virtual items.
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: /expand note/i }))
    expect(screen.getByRole('button', { name: /collapse note/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /collapse note/i }))
    // Collapse keeps the full content mounted through the morph and only swaps
    // to truncated at the end (rAF `finish` → `onCommit`), so the expand
    // affordance returns asynchronously once the morph commits.
    expect(await screen.findByRole('button', { name: /expand note/i })).toBeInTheDocument()
  })
})

describe('Feed scroll restore + capture (v0.7)', () => {
  /** Read the captured virtualizer's merged options (seed fields live here). */
  const seedOptions = () => {
    const v = virtualMock.latest as {
      options: {
        initialOffset: number | (() => number)
        initialMeasurementsCache: Array<{ key: string | number }>
      }
    } | null
    if (!v) throw new Error('virtualizer instance was not captured')
    return v.options
  }

  it('seeds initialMeasurementsCache + initialOffset when persisted indices still match (mode:seed)', async () => {
    const notes = [makeNote('n0', 'a'), makeNote('n1', 'b')]
    // snapshot[i].key === noteIds[i] for both → indicesMatch → mode:'seed'.
    const snapshot = [
      { key: 'n0', index: 0, start: 0, end: 100, size: 100, lane: 0 },
      { key: 'n1', index: 1, start: 100, end: 220, size: 120, lane: 0 },
    ]
    const restore = { snapshot, offset: 500, anchor: { key: 'n0', delta: 0, atEnd: false } }
    render(
      <Feed
        notes={notes}
        restore={restore}
        focusedId={null}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    await act(async () => {})
    const opts = seedOptions()
    // The seed options reach useVirtualizer at its first render (the flash-free path).
    expect(opts.initialOffset).toBe(500)
    expect(opts.initialMeasurementsCache).toEqual(snapshot)
  })

  it('does NOT seed a stale cache when the persisted indices no longer map to the same ids', async () => {
    const notes = [makeNote('n0', 'a'), makeNote('n1', 'b')]
    // snapshot keys map to DIFFERENT ids than the current notes → NOT seed. anchor.key
    // 'n1' still resolves, so pickFeedRestore falls to mode:'index' — the seed options
    // must stay unset (carry-forward: initialMeasurementsCache only for mode:'seed').
    const snapshot = [
      { key: 'stale-a', index: 0, start: 0, end: 100, size: 100, lane: 0 },
      { key: 'stale-b', index: 1, start: 100, end: 200, size: 100, lane: 0 },
    ]
    const restore = { snapshot, offset: 500, anchor: { key: 'n1', delta: 0, atEnd: false } }
    render(
      <Feed
        notes={notes}
        restore={restore}
        focusedId={null}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    await act(async () => {})
    const opts = seedOptions()
    // `undefined` seed options are skipped by virtual-core's setOptions → defaults kept.
    expect(opts.initialOffset).toBe(0)
    expect(opts.initialMeasurementsCache).toEqual([])
  })

  it('reports a trailing-throttled onCapture with snapshot/offset/anchor on scroll', async () => {
    const onCapture = vi.fn()
    const notes = [makeNote('n0', 'a'), makeNote('n1', 'b')]
    render(
      <Feed
        notes={notes}
        onCapture={onCapture}
        focusedId={null}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    await act(async () => {})
    const scroller = document.querySelector('.scroll-area-inner')
    if (!scroller) throw new Error('feed scroller not found')
    const el = scroller as HTMLElement
    el.scrollTop = 40
    fireEvent.scroll(el)
    await waitFor(() => expect(onCapture).toHaveBeenCalled())
    const arg = onCapture.mock.calls[0]?.[0] as {
      snapshot: unknown
      offset: unknown
      anchor: unknown
    }
    expect(Array.isArray(arg.snapshot)).toBe(true)
    expect(typeof arg.offset).toBe('number')
    expect('anchor' in arg).toBe(true)
  })
})
