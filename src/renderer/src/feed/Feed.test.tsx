import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { installMockApi, renderWithProviders } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'
import { Feed } from './Feed'

// jsdom has no layout engine so offsetHeight is always 0.
// @tanstack/react-virtual's observeElementRect reads offsetHeight for getSize(),
// which gates getVirtualItems() on outerSize > 0. Without a non-zero size the
// virtualizer renders no items and NoteBubble is never mounted.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return 600
    },
  })
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
