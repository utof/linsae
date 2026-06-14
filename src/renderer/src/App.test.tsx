// @vitest-environment happy-dom
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, type MockApi, renderWithProviders } from '../../../tests/setup'
import type { Note } from '../../shared/types'
import { useCommandStore } from './palette/command-store'

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

// Mock Feed to a minimal component that exposes one "open thread" button per
// note in the list. Each button fires onOpenThread with its note's id so tests
// can navigate to specific threads. Avoids the full virtualizer + DOM measurement
// path in jsdom.
vi.mock('./feed/Feed', () => ({
  Feed: ({
    onOpenThread,
    notes,
    sendInFlight,
  }: {
    onOpenThread?: (id: string) => void
    notes: Note[]
    sendInFlight?: boolean
  }) => (
    <div data-testid="feed-sentinel" data-send-in-flight={String(!!sendInFlight)}>
      {notes.map((n) => (
        <button
          key={n.id}
          type="button"
          data-testid={`open-thread-btn-${n.id}`}
          onClick={() => onOpenThread?.(n.id)}
        >
          {`open thread ${n.id}`}
        </button>
      ))}
      {/* Legacy alias: fires note-src-1, used by existing tests that rely on FEED_NOTE seeding. */}
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

/** Second source note for A→B thread navigation test. */
const SOURCE_NOTE_B: Note = {
  id: 'note-src-2',
  slug: 'note-src-2',
  body: '',
  type: 'source',
  created_at: 2000,
  updated_at: 2000,
  deleted_at: null,
  source_kind: 'youtube',
  source_locator: { media: 'youtube', video_id: 'oHg5SJYRHA0' },
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

  it('(c) navigating A→B swaps ThreadView noteId (proves key={threadNoteId} remount)', async () => {
    // Seed two source notes so the Feed mock renders per-note open-thread buttons.
    // Proves key={threadNoteId} wires the noteId prop swap: A must show A's id,
    // then after close+reopen to B, ThreadView must show B's id.
    mockApi.notes.list.mockResolvedValue([CREATED_SOURCE_NOTE, SOURCE_NOTE_B])
    renderWithProviders(<App />)

    // Wait for both per-note buttons to appear.
    await screen.findByTestId('open-thread-btn-note-src-1')
    await screen.findByTestId('open-thread-btn-note-src-2')

    // Open thread A.
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-thread-btn-note-src-1'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('thread-view-sentinel')).toHaveAttribute(
        'data-note-id',
        'note-src-1',
      )
    })

    // Close thread A.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('back'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('feed-sentinel')).toBeInTheDocument()
    })

    // Open thread B.
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-thread-btn-note-src-2'))
    })
    await waitFor(() => {
      // ThreadView must now carry B's id — proves noteId prop changed + remount.
      expect(screen.getByTestId('thread-view-sentinel')).toHaveAttribute(
        'data-note-id',
        'note-src-2',
      )
    })
    // Feed and composer must be absent while thread B is open.
    expect(screen.queryByTestId('feed-sentinel')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})

describe('App — base command registration (⌘K)', () => {
  afterEach(() => useCommandStore.getState().reset())

  it('registers the base command set on mount with the expected shape', async () => {
    renderWithProviders(<App />)
    // Wait for the registration effect to flush (it runs after the first commit).
    await waitFor(() => expect(useCommandStore.getState().commands().length).toBeGreaterThan(0))

    const cmds = useCommandStore.getState().commands()
    const byId = new Map(cmds.map((c) => [c.id, c]))
    expect([...byId.keys()].sort()).toEqual(
      ['app.settings', 'note.new', 'search.content', 'search.title', 'view.recent'].sort(),
    )
    // The two search doors carry their hotkey hints (rendered on the ⌘K rows).
    expect(byId.get('search.title')?.hint).toBe('⌘O')
    expect(byId.get('search.content')?.hint).toBe('⌘P')
    // `view.recent` is canvas-gated; App starts in feed view, so its when() is false.
    expect(byId.get('view.recent')?.when?.()).toBe(false)
  })

  it('running search.title opens the QuickSwitcher (flips activePalette to title)', async () => {
    renderWithProviders(<App />)
    await waitFor(() => expect(useCommandStore.getState().commands().length).toBeGreaterThan(0))

    // The QuickSwitcher is not mounted until its slot is active.
    expect(screen.queryByPlaceholderText('jump to a note by title…')).toBeNull()

    // Invoke the REAL registered command's run() — exercises the App-wired closure.
    const run = useCommandStore.getState().registry.get('search.title')?.run
    expect(run).toBeTypeOf('function')
    await act(async () => {
      run?.()
    })

    // ContentSearch must NOT also open — the single-open coordinator guarantees it.
    expect(await screen.findByPlaceholderText('jump to a note by title…')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('type to search your notes.')).toBeNull()
  })
})

describe('App — sendInFlight append-coupled clear', () => {
  it('arms sendInFlight on submit and clears it once the append lands (not on a fixed timer)', async () => {
    // Seed one note so Feed renders (not the "nothing yet" fallback).
    mockApi.notes.list.mockResolvedValueOnce([FEED_NOTE]) // initial load
    mockApi.notes.create.mockResolvedValueOnce({ ...FEED_NOTE, id: 'n2' })
    // After create → invalidate → refetch the list grows to two notes.
    mockApi.notes.list.mockResolvedValue([FEED_NOTE, { ...FEED_NOTE, id: 'n2' }])

    renderWithProviders(<App />)

    // Wait for Feed to render (initial query settled). Done before freezing timers
    // so React Query's own setTimeout-based machinery can run normally.
    const feed = await screen.findByTestId('feed-sentinel')

    // Now freeze time so the fail-safe (4000ms) cannot fire. The append-coupled
    // effect (notes.length grows 1→2) must be the only way sendInFlight clears.
    vi.useFakeTimers()
    try {
      // Type a body in the create-composer. Change only — no submit yet.
      const ta = screen.getByRole('textbox')
      fireEvent.change(ta, { target: { value: 'hello world' } })

      // Press Enter to submit. Use non-async act so React flushes state changes
      // (beginSend → setSendInFlight(true)) synchronously before we assert.
      act(() => {
        fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false })
      })

      // sendInFlight must be armed immediately after submit (before the async append).
      // The create mock has not yet resolved — notes.length is still 1.
      expect(feed.getAttribute('data-send-in-flight')).toBe('true')

      // Flush the create mutation's microtask chain (promises resolve under fake timers).
      // createMut.mutate → api.notes.create → onSuccess → invalidate → notes.list refetch
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

      // After the refetch the notes list grew to 2. The append-coupled effect fires
      // synchronously on the notes.length dependency change. Timers are still at 0ms —
      // the fail-safe at 4000ms cannot be the cause of the clear.
      expect(screen.getByTestId('feed-sentinel').getAttribute('data-send-in-flight')).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })
})
