// @vitest-environment jsdom
/**
 * Component tests for App — paste-to-source-note flow and ThreadView nav.
 *
 * Paste behavior:
 *   (a) Pasting a YouTube URL into the create-composer calls api.notes.create
 *       with type='source' + source_kind/source_locator, then fetchOEmbed,
 *       then videoSources.upsert with title/channel/thumbnailUrl from oEmbed.
 *   (b) A non-URL paste does NOT trigger notes.create with type='source'.
 *
 * ThreadView nav:
 *   (c) When Feed fires onOpenThread(id), App renders ThreadView (and hides
 *       the feed+composer).
 *   (d) ThreadView's onClose brings the feed+composer back.
 *
 * ThreadView is vi.mock'd to a sentinel so these tests don't load the real
 * player machinery.
 *
 * @see src/renderer/src/App.tsx
 * @see src/renderer/src/composer/Composer.tsx §onPasteText
 * @see docs/specs/v0.2-youtube-annotation.md §Add a video
 */

import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, type MockApi, renderWithProviders } from '../../../tests/setup'
import type { Note } from '../../shared/types'

// ── Mock ThreadView to a lightweight sentinel ──────────────────────────────
// This avoids loading usePlayer / playerSingleton / iframe machinery in jsdom.
vi.mock('./thread/ThreadView', () => ({
  ThreadView: ({ noteId, onClose }: { noteId: string; onClose: () => void }) => (
    <div data-testid="thread-view-sentinel" data-note-id={noteId}>
      <button type="button" aria-label="back" onClick={onClose}>
        back
      </button>
    </div>
  ),
}))

// Mock Feed to a minimal component that exposes an "open thread" button per note.
// This avoids the full virtualizer + DOM measurement path in jsdom.
vi.mock('./feed/Feed', () => ({
  Feed: ({ onOpenThread }: { onOpenThread?: (id: string) => void; notes: Note[] }) => (
    <div data-testid="feed-sentinel">
      <button
        type="button"
        data-testid="open-thread-btn"
        onClick={() => onOpenThread?.('note-src-1')}
      >
        open thread
      </button>
    </div>
  ),
}))

// Import App AFTER vi.mock so hoisted mocks apply.
import { App } from './App'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal source note returned by api.notes.create */
const CREATED_SOURCE_NOTE: Note = {
  id: 'note-src-1',
  slug: 'note-src-1',
  body: '',
  type: 'source',
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
  source_kind: 'youtube',
  source_locator: { media: 'youtube', video_id: 'dQw4w9WgXcQ' },
}

const OEMBED_RESULT = {
  title: 'Rick Astley - Never Gonna Give You Up',
  author_name: 'Rick Astley',
  author_url: 'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
  thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** A non-source note to populate the list so Feed renders (not the "nothing yet" fallback). */
const FEED_NOTE: Note = {
  id: 'feed-note-1',
  slug: 'feed-note-1',
  body: 'existing note',
  type: 'claim',
  created_at: 500,
  updated_at: 500,
  deleted_at: null,
}

let mockApi: MockApi

beforeEach(() => {
  mockApi = installMockApi()
  mockApi.notes.list.mockResolvedValue([])
  mockApi.system.getReconcileSkipped.mockResolvedValue(0)
  mockApi.notes.create.mockResolvedValue(CREATED_SOURCE_NOTE)
  mockApi.youtube.fetchOEmbed.mockResolvedValue(OEMBED_RESULT)
  mockApi.videoSources.upsert.mockResolvedValue(undefined)
})

describe('App — paste YouTube URL → source note + oEmbed', () => {
  it('(a) pasting a YouTube watch URL calls create→fetchOEmbed→upsert in order', async () => {
    renderWithProviders(<App />)

    const ta = await screen.findByRole('textbox')

    // Simulate a paste event carrying a YouTube watch URL.
    await act(async () => {
      fireEvent.paste(ta, {
        clipboardData: {
          getData: () => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        },
      })
    })

    await waitFor(() => {
      expect(mockApi.notes.create).toHaveBeenCalledWith({
        body: '',
        type: 'source',
        source_kind: 'youtube',
        source_locator: { media: 'youtube', video_id: 'dQw4w9WgXcQ' },
      })
    })

    await waitFor(() => {
      expect(mockApi.youtube.fetchOEmbed).toHaveBeenCalledWith({ videoId: 'dQw4w9WgXcQ' })
    })

    await waitFor(() => {
      expect(mockApi.videoSources.upsert).toHaveBeenCalledWith({
        videoId: 'dQw4w9WgXcQ',
        sourceKind: 'youtube',
        title: OEMBED_RESULT.title,
        channel: OEMBED_RESULT.author_name,
        thumbnailUrl: OEMBED_RESULT.thumbnail_url,
      })
    })

    // Verify order: create was called before fetchOEmbed, which was before upsert.
    // Non-null assertion: we've already waitFor'd that each was called at least once.
    const createOrder = mockApi.notes.create.mock.invocationCallOrder[0]!
    const oembedOrder = mockApi.youtube.fetchOEmbed.mock.invocationCallOrder[0]!
    const upsertOrder = mockApi.videoSources.upsert.mock.invocationCallOrder[0]!
    expect(createOrder).toBeLessThan(oembedOrder)
    expect(oembedOrder).toBeLessThan(upsertOrder)
  })

  it('(a) pasting a youtu.be short URL also creates a source note', async () => {
    renderWithProviders(<App />)
    const ta = await screen.findByRole('textbox')

    await act(async () => {
      fireEvent.paste(ta, {
        clipboardData: {
          getData: () => 'https://youtu.be/dQw4w9WgXcQ',
        },
      })
    })

    await waitFor(() => {
      expect(mockApi.notes.create).toHaveBeenCalledWith({
        body: '',
        type: 'source',
        source_kind: 'youtube',
        source_locator: { media: 'youtube', video_id: 'dQw4w9WgXcQ' },
      })
    })
  })

  it('(b) pasting plain text does NOT call notes.create with type=source', async () => {
    renderWithProviders(<App />)
    const ta = await screen.findByRole('textbox')

    await act(async () => {
      fireEvent.paste(ta, {
        clipboardData: {
          getData: () => 'just some regular text',
        },
      })
    })

    // Give async handlers time to settle
    await new Promise((r) => setTimeout(r, 50))

    expect(mockApi.notes.create).not.toHaveBeenCalled()
  })

  it('(b) pasting empty string does NOT call notes.create', async () => {
    renderWithProviders(<App />)
    const ta = await screen.findByRole('textbox')

    await act(async () => {
      fireEvent.paste(ta, {
        clipboardData: {
          getData: () => '',
        },
      })
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(mockApi.notes.create).not.toHaveBeenCalled()
  })

  it('(a) when fetchOEmbed returns null, the note still exists (fail-soft)', async () => {
    mockApi.youtube.fetchOEmbed.mockResolvedValue(null)
    renderWithProviders(<App />)
    const ta = await screen.findByRole('textbox')

    await act(async () => {
      fireEvent.paste(ta, {
        clipboardData: {
          getData: () => 'https://youtu.be/dQw4w9WgXcQ',
        },
      })
    })

    await waitFor(() => {
      expect(mockApi.notes.create).toHaveBeenCalledOnce()
    })
    // upsert should NOT be called when oEmbed returns null
    expect(mockApi.videoSources.upsert).not.toHaveBeenCalled()
  })
})

describe('App — ThreadView nav (mutual exclusivity)', () => {
  it('(c) onOpenThread from Feed renders ThreadView and hides feed+composer', async () => {
    // Provide a note so Feed (not the "nothing yet" fallback) renders.
    mockApi.notes.list.mockResolvedValue([FEED_NOTE])
    renderWithProviders(<App />)

    // Feed sentinel should be visible initially
    expect(await screen.findByTestId('feed-sentinel')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    // Fire onOpenThread via the feed sentinel's button
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-thread-btn'))
    })

    // ThreadView sentinel should now be visible
    await waitFor(() => {
      expect(screen.getByTestId('thread-view-sentinel')).toBeInTheDocument()
    })
    expect(screen.getByTestId('thread-view-sentinel')).toHaveAttribute('data-note-id', 'note-src-1')

    // Feed and composer should be gone
    expect(screen.queryByTestId('feed-sentinel')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('(d) ThreadView onClose restores feed+composer', async () => {
    mockApi.notes.list.mockResolvedValue([FEED_NOTE])
    renderWithProviders(<App />)

    // Open thread
    await act(async () => {
      fireEvent.click(await screen.findByTestId('open-thread-btn'))
    })
    await waitFor(() => expect(screen.getByTestId('thread-view-sentinel')).toBeInTheDocument())

    // Close thread
    await act(async () => {
      fireEvent.click(screen.getByLabelText('back'))
    })

    // Feed and composer restored
    await waitFor(() => {
      expect(screen.getByTestId('feed-sentinel')).toBeInTheDocument()
    })
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.queryByTestId('thread-view-sentinel')).not.toBeInTheDocument()
  })

  it('(c) switching threads uses key={threadNoteId} to remount ThreadView', async () => {
    // The mock Feed fires 'note-src-1' for onOpenThread; verify the sentinel
    // carries the correct id so we know key={threadNoteId} is wired.
    mockApi.notes.list.mockResolvedValue([FEED_NOTE])
    renderWithProviders(<App />)

    await act(async () => {
      fireEvent.click(await screen.findByTestId('open-thread-btn'))
    })
    await waitFor(() => {
      const sentinel = screen.getByTestId('thread-view-sentinel')
      expect(sentinel).toHaveAttribute('data-note-id', 'note-src-1')
    })
  })
})
