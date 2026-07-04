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
import type { Note, PdfLocator } from '../../shared/types'
import { useCommandStore } from './palette/command-store'
import { useDockStore } from './panes/dockStore'
import { useExcerptStore } from './pdf/excerptState'

// ── Mock ThreadView to a lightweight sentinel ──────────────────────────────
// This avoids loading usePlayer / playerSingleton / iframe machinery in jsdom.
vi.mock('./thread/ThreadView', () => ({
  ThreadView: ({
    noteId,
    onClose,
    onScroll,
  }: {
    noteId: string
    onClose: () => void
    onScroll?: (scrollTop: number) => void
  }) => (
    <div data-testid="thread-view-sentinel" data-note-id={noteId}>
      <button type="button" aria-label="back" onClick={onClose}>
        back
      </button>
      {/* Task 2.2: drive App's onScroll wiring so the thread.scroll.v1 persist can be asserted. */}
      <button type="button" data-testid="thread-view-scroll" onClick={() => onScroll?.(240)}>
        scroll
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
    onFocus,
    focusedId,
    notes,
    sendInFlight,
  }: {
    onOpenThread?: (id: string) => void
    onFocus?: (id: string) => void
    focusedId?: string | null
    notes: Note[]
    sendInFlight?: boolean
  }) => (
    <div
      data-testid="feed-sentinel"
      data-send-in-flight={String(!!sendInFlight)}
      data-focused-id={focusedId ?? ''}
    >
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
      {/* Focus triggers (Task 6): drive the focus↔backlinks-pane sync. App's onFocus
          toggles, so clicking the same note twice clears focus (used for the I2 case). */}
      {notes.map((n) => (
        <button
          key={`focus-${n.id}`}
          type="button"
          data-testid={`focus-btn-${n.id}`}
          onClick={() => onFocus?.(n.id)}
        >
          {`focus ${n.id}`}
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

// Mock the open-pdf id hooks so tests can drive boot-restore deterministically.
// Default: no pdf open (usePdfOpenId → null) + a no-op setter, so EXISTING tests
// are unaffected; the boot-restore describe overrides the return values per-test.
vi.mock('./pdf/usePdfOpenId', () => ({
  usePdfOpenId: vi.fn(() => null),
  useOpenPdf: vi.fn(() => vi.fn()),
}))

// Import App AFTER vi.mock so hoisted mocks apply.
import { App } from './App'
import * as PaneModule from './panes/Pane'
import { useOpenPdf, usePdfOpenId } from './pdf/usePdfOpenId'

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
  // The dock store is an in-memory singleton; vitest's `isolate:false` leaks it
  // across files, so reset it for every App test (starts empty per test).
  useDockStore.getState().reset()
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
  /**
   * v0.6.4 B1 relocation invariant: opening a thread must NOT unmount the
   * left or right DockHost. Before the fix, the thread replaced the whole
   * body row (ThreadView vs <>DockHost+main+DockHost</>), so both docks
   * were torn down every time a thread opened — closing the docked PDF
   * reader / YouTube player. After the fix the thread is a branch INSIDE
   * <main>, peer to canvas/feed, so docks are always mounted.
   *
   * pane choices: 'shelf' (left) and 'backlinks' (right) are opened
   * directly via the store — no note focus needed. Because openThread()
   * calls setFocusedId(null) and focusedId was already null, the I2
   * effect (null focus → close backlinks) does NOT re-run, so backlinks
   * stays open throughout the test.
   *
   * @see docs/plans/v0.6.4-notes-as-threads.md §Task 1.2
   * @see src/renderer/src/panes/DockHost.tsx — data-testid="dock-{side}"
   */
  it('keeps both docks mounted when a thread opens (v0.6.4 relocation)', async () => {
    mockApi.notes.list.mockResolvedValue([FEED_NOTE])
    renderWithProviders(<App />)

    // Open a pane on each side so DockHost renders (null-guard passes).
    act(() => {
      useDockStore.getState().openPane('shelf')
    })
    act(() => {
      useDockStore.getState().openPane('backlinks')
    })

    // Wait for both docks to be in the DOM (state update has committed).
    await waitFor(() => expect(screen.getByTestId('dock-left')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('dock-right')).toBeInTheDocument())

    // Open a thread via the Feed sentinel button.
    await act(async () => {
      fireEvent.click(await screen.findByTestId('open-thread-btn'))
    })
    await waitFor(() => expect(screen.getByTestId('thread-view-sentinel')).toBeInTheDocument())

    // Both docks must still be mounted — the thread is a sub-state of
    // <main>, not a body-level replacement of the dock row (v0.6.4 B1).
    expect(screen.getByTestId('dock-left')).toBeInTheDocument()
    expect(screen.getByTestId('dock-right')).toBeInTheDocument()
  })

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
      [
        'app.settings',
        'note.new',
        'pdf.open',
        'search.content',
        'search.title',
        'view.recent',
      ].sort(),
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

describe('App — switcher freshness (note-titles / note-recent invalidation)', () => {
  afterEach(() => useCommandStore.getState().reset())

  /**
   * Freshness regression (spec §3 / blocker): creating a note must invalidate the
   * ⌘O switcher's `['note-titles']` feed AND the recent empty-state `['note-recent']`,
   * so the live switcher reflects the new note. The push-based cache (staleTime:
   * Infinity, refetchOnWindowFocus:false) only refetches on explicit invalidation.
   *
   * The switcher is kept OPEN across the mutation so its `['note-titles']` +
   * `['note-recent']` observers stay mounted+enabled — the ONLY thing that can
   * trigger a second listTitles/recent call is `invalidate()` touching those keys.
   * (A close→reopen would refetch on re-enable regardless of invalidation, which
   * would not distinguish the fix; hence we hold it open.) Without the fix, create
   * invalidates only `['notes']`/`['note']`/`['canvas-edges']` → listTitles/recent
   * stay at one call → this test fails.
   */
  it('a note create (switcher open) re-fetches note-titles AND note-recent', async () => {
    mockApi.notes.list.mockResolvedValue([FEED_NOTE])
    mockApi.notes.create.mockResolvedValue({ ...FEED_NOTE, id: 'n2', body: 'fresh note' })
    renderWithProviders(<App />)

    // Wait for the base commands to register so we can drive search.title's run().
    await waitFor(() => expect(useCommandStore.getState().commands().length).toBeGreaterThan(0))

    // Open ⌘O — listTitles + recent fetch once each (enabled: open). Keep it open.
    await act(async () => {
      useCommandStore.getState().registry.get('search.title')?.run?.()
    })
    await waitFor(() => expect(mockApi.notes.listTitles).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockApi.notes.recent).toHaveBeenCalledTimes(1))

    // Create a note through the real composer textarea (behind the open dialog,
    // so aria-hidden — query the DOM node directly rather than by role) → the real
    // createMut.onSuccess → invalidate().
    const ta = document.querySelector<HTMLTextAreaElement>('.composer-textarea')
    if (!ta) throw new Error('composer textarea not found')
    fireEvent.change(ta, { target: { value: 'fresh note' } })
    await act(async () => {
      fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false })
    })
    await waitFor(() => expect(mockApi.notes.create).toHaveBeenCalled())

    // invalidate() must now mark ['note-titles'] + ['note-recent'] stale; both
    // observers are still mounted+enabled, so react-query re-fetches each once more.
    await waitFor(() => expect(mockApi.notes.listTitles).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mockApi.notes.recent).toHaveBeenCalledTimes(2))
  })
})

describe('App — PDF excerpt → canvas placement bridge (B3)', () => {
  /** Stable locator fixture for the B3 test. */
  const LOCATOR: PdfLocator = {
    media: 'pdf',
    pdf_id: 'p1',
    page: 1,
    rect: [10, 20, 100, 30],
    quote: 'quote',
    prefix: '',
    suffix: '',
  }

  /** Source note that the PDF open created for pdfId='p1'. Slug 'd1' is the commentOn target. */
  const PDF_SRC_NOTE: Note = {
    id: 'note-pdf-src-p1',
    slug: 'd1',
    body: '',
    type: 'source',
    created_at: 900,
    updated_at: 900,
    deleted_at: null,
    source_kind: 'pdf',
    source_locator: { media: 'pdf', pdf_id: 'p1' },
  }

  /** The excerpt child note returned by api.notes.create for the claim. */
  const EXCERPT_CHILD: Note = {
    id: 'excerpt-1',
    slug: 'excerpt-1',
    body: 'quote',
    type: 'claim',
    created_at: 3000,
    updated_at: 3000,
    deleted_at: null,
    source_kind: 'pdf',
    source_locator: LOCATOR,
  }

  beforeEach(() => {
    // Reset the excerpt store so state never leaks between tests.
    useExcerptStore.getState().clear()
  })
  afterEach(() => {
    useExcerptStore.getState().clear()
    // Reset command registrations left by App mount (mirrors the switcher-freshness
    // describe; needed now that one B3 test opens the ⌘O switcher).
    useCommandStore.getState().reset()
  })

  /**
   * B3 invariant (round-2 review): selection alone (set without arm) must
   * never create a note; only the explicit "Excerpt →" affordance (arm) may
   * trigger a create. This prevents orphan notes on every re-selection.
   *
   * @see src/renderer/src/pdf/excerptState.ts ExcerptState.armed
   * @see docs/specs/v0.6-pdf-slim-slice.md §7
   */
  it('B3: selection alone does not create a note; arm() triggers exactly one create', async () => {
    // findSourceByPdfId returns the PDF source note so create is called only once
    // (for the excerpt child — not also for the fallback source creation).
    mockApi.notes.findSourceByPdfId.mockResolvedValue(PDF_SRC_NOTE)
    mockApi.notes.create.mockResolvedValue(EXCERPT_CHILD)
    renderWithProviders(<App />)
    // Wait for App to settle so the bridge useEffect is wired and armed.
    await screen.findByRole('textbox')

    // B3 negative: set pending WITHOUT arming → create must NOT fire.
    act(() => {
      useExcerptStore.getState().set({ text: 'quote', locator: LOCATOR, pdfId: 'p1', page: 1 })
    })
    // Give React a tick to flush state changes and run any effects.
    await new Promise((r) => setTimeout(r, 50))
    expect(mockApi.notes.create).not.toHaveBeenCalled()

    // B3 positive: arm() → bridge effect fires → create called exactly once
    // (findSourceByPdfId resolved so no fallback source-create call).
    await act(async () => {
      useExcerptStore.getState().arm()
    })
    await waitFor(() => {
      expect(mockApi.notes.create).toHaveBeenCalledOnce()
    })
    // v0.6.4 B4: excerpt is type='claim' + commentOn the PDF source note slug,
    // not type='source' (v0.6 behaviour). The comment-on edge wires it into the
    // PDF's thread. @see docs/specs/v0.6.4-notes-as-threads.md §Task 4.1
    expect(mockApi.notes.create).toHaveBeenCalledWith({
      body: 'quote',
      type: 'claim',
      source_kind: 'pdf',
      source_locator: LOCATOR,
      commentOn: 'd1',
    })
  })

  /**
   * B4 (v0.6.4): arming the PDF excerpt from the feed view must post a
   * comment-on child into the PDF's thread WITHOUT switching to the canvas.
   * The forced setViewMode('canvas') from v0.6.3 is removed — excerpting
   * from feed/thread must not yank the user to the canvas view.
   *
   * Assertions:
   *   1. findSourceByPdfId called with the excerpt's pdfId.
   *   2. notes.create called with type='claim' + commentOn=<source slug>.
   *   3. View stays 'feed' (canvas toggle stays aria-pressed=false).
   *
   * @see src/renderer/src/App.tsx — excerpt bridge useEffect
   * @see docs/specs/v0.6.4-notes-as-threads.md §Task 4.1
   */
  it('B4: arming excerpt from feed creates comment-on child and does NOT switch to canvas', async () => {
    mockApi.notes.findSourceByPdfId.mockResolvedValue(PDF_SRC_NOTE)
    mockApi.notes.create.mockResolvedValue(EXCERPT_CHILD)

    renderWithProviders(<App />)
    await screen.findByRole('textbox')

    // Confirm starting on feed view.
    expect(screen.getByRole('button', { name: 'canvas view' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )

    // Arm the excerpt (simulates clicking "Excerpt →" in the PDF reader).
    act(() => {
      useExcerptStore.getState().set({ text: 'quote', locator: LOCATOR, pdfId: 'p1', page: 1 })
    })
    await act(async () => {
      useExcerptStore.getState().arm()
    })

    // 1. findSourceByPdfId must resolve the PDF's source note.
    await waitFor(() =>
      expect(mockApi.notes.findSourceByPdfId).toHaveBeenCalledWith({ pdfId: 'p1' }),
    )

    // 2. notes.create called with the excerpt text as a comment-on child.
    await waitFor(() =>
      expect(mockApi.notes.create).toHaveBeenCalledWith({
        body: 'quote',
        type: 'claim',
        source_kind: 'pdf',
        source_locator: LOCATOR,
        commentOn: 'd1',
      }),
    )

    // 3. View must stay feed — no forced canvas switch (B4 spec change).
    expect(screen.getByRole('button', { name: 'canvas view' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  /**
   * B4 (v0.6.4): the bridge consumes the excerpt store synchronously (clearExcerpt
   * before the await) to guarantee create-exactly-once. The cost: a failed create
   * would silently drop the user's selection. The catch restores it so the text
   * survives and the user can retry — without re-creating (restored with armed=false).
   * @see src/renderer/src/App.tsx — excerpt bridge catch
   */
  it('B4: restores the excerpt when the create fails (no silent data-loss)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockApi.notes.findSourceByPdfId.mockResolvedValue(PDF_SRC_NOTE)
    mockApi.notes.create.mockRejectedValue(new Error('create failed'))

    renderWithProviders(<App />)
    await screen.findByRole('textbox')

    const excerpt = { text: 'quote', locator: LOCATOR, pdfId: 'p1', page: 1 }
    act(() => {
      useExcerptStore.getState().set(excerpt)
    })
    await act(async () => {
      useExcerptStore.getState().arm()
    })

    // The child create was attempted and threw...
    await waitFor(() => expect(mockApi.notes.create).toHaveBeenCalled())
    // ...and on its rejection the excerpt is restored (not lost), disarmed for retry.
    await waitFor(() => expect(useExcerptStore.getState().pending).toEqual(excerpt))
    expect(useExcerptStore.getState().armed).toBe(false)
    errSpy.mockRestore()
  })

  /**
   * v0.6.3 test updated for v0.6.4 (B4): the forced canvas switch is gone.
   * Arming from feed stays on feed; the excerpt child lands in the PDF thread.
   * The old test asserted aria-pressed='true' (canvas switch) — that assertion
   * is now inverted to aria-pressed='false' (stays feed), proving the removal.
   *
   * @see src/renderer/src/App.tsx — excerpt bridge useEffect (setViewMode removed)
   * @see docs/specs/v0.6.4-notes-as-threads.md §Task 4.1 (B4)
   */
  it('arming excerpt on feed stays on feed (no forced canvas switch — v0.6.4 B4)', async () => {
    mockApi.notes.findSourceByPdfId.mockResolvedValue(PDF_SRC_NOTE)
    mockApi.notes.create.mockResolvedValue(EXCERPT_CHILD)

    renderWithProviders(<App />)
    await screen.findByRole('textbox')

    // App boots in feed view.
    const canvasToggle = screen.getByRole('button', { name: 'canvas view' })
    expect(canvasToggle).toHaveAttribute('aria-pressed', 'false')

    act(() => {
      useExcerptStore.getState().set({ text: 'quote', locator: LOCATOR, pdfId: 'p1', page: 1 })
    })
    await act(async () => {
      useExcerptStore.getState().arm()
    })
    await waitFor(() => expect(mockApi.notes.create).toHaveBeenCalledOnce())

    // The view must STAY feed (v0.6.4 B4 removes the forced canvas switch).
    // The excerpt child lands in the PDF thread — no ghost placement needed.
    expect(screen.getByRole('button', { name: 'canvas view' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  /**
   * Cache-invalidation guard (spec §3 / blocker): arm() must invalidate the
   * ['note-titles'] and ['note-recent'] caches so the excerpted note immediately
   * appears in the ⌘O switcher, ⌘J recent, and the feed — not just on canvas.
   *
   * Mechanism mirrors the createMut freshness test above: keep the ⌘O switcher
   * open so its queries have active observers; assert they refetch after arm().
   * Without the invalidate() call in the bridge, listTitles/recent stay at one
   * call (no refetch triggered) and this test fails.
   *
   * @see src/renderer/src/App.tsx — excerpt bridge useEffect
   * @see docs/specs/v0.6-pdf-slim-slice.md §7
   */
  it('B3: arm() invalidates note-titles and note-recent caches (switcher/recent freshness)', async () => {
    // Mock findSourceByPdfId so create fires once (just the excerpt child).
    mockApi.notes.findSourceByPdfId.mockResolvedValue(PDF_SRC_NOTE)
    mockApi.notes.create.mockResolvedValue(EXCERPT_CHILD)
    renderWithProviders(<App />)
    await screen.findByRole('textbox')

    // Wait for base commands to register (the command effect runs post-mount).
    await waitFor(() => expect(useCommandStore.getState().commands().length).toBeGreaterThan(0))

    // Open ⌘O switcher — listTitles + recent each fetch once (enabled: open).
    // Keep the switcher open so its observers stay mounted and a refetch is
    // detectable (a close→reopen would refetch on re-enable regardless).
    await act(async () => {
      useCommandStore.getState().registry.get('search.title')?.run?.()
    })
    await waitFor(() => expect(mockApi.notes.listTitles).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockApi.notes.recent).toHaveBeenCalledTimes(1))

    // Set pending + arm → bridge fires → note created → invalidate() called.
    act(() => {
      useExcerptStore.getState().set({ text: 'quote', locator: LOCATOR, pdfId: 'p1', page: 1 })
    })
    await act(async () => {
      useExcerptStore.getState().arm()
    })
    await waitFor(() => expect(mockApi.notes.create).toHaveBeenCalledOnce())

    // invalidate() marks ['note-titles'] + ['note-recent'] stale; the open
    // observers refetch. Each must now be at two calls.
    await waitFor(() => expect(mockApi.notes.listTitles).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mockApi.notes.recent).toHaveBeenCalledTimes(2))
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

describe('App — PDF boot-restore (C2)', () => {
  beforeEach(() => {
    // Spy getPane so the right dock's 'pdf' pane renders a trivial body instead
    // of mounting the real PdfReader (which pulls pdfjs/worker machinery).
    vi.spyOn(PaneModule, 'getPane').mockImplementation((id: string) =>
      id === 'pdf'
        ? {
            id,
            title: 'pdf',
            homeDock: 'right',
            kind: 'content',
            render: () => <div>pdf body</div>,
          }
        : { id, title: id, homeDock: 'left', kind: 'utility', render: () => <div>{id} body</div> },
    )
  })
  afterEach(() => {
    // Restore the getPane spy first; restoreAllMocks also resets the factory
    // mocks, so re-establish their defaults AFTER it (else the resets are dead).
    vi.restoreAllMocks()
    vi.mocked(usePdfOpenId).mockReturnValue(null)
    vi.mocked(useOpenPdf).mockReturnValue(vi.fn())
  })

  /**
   * C2 invariant (spec §4/§5): the persisted open-pdf id must reopen the right
   * dock pane on boot (the in-memory store starts empty), and closing it must
   * clear the persisted id so the restore effect does not immediately reopen it.
   * @see docs/specs/v0.6.2-dock-shell.md §4 (C2)
   */
  it('reopens the pdf pane when the persisted id resolves; close clears the id', async () => {
    const openPdfSpy = vi.fn()
    vi.mocked(usePdfOpenId).mockReturnValue('pdf-abc')
    vi.mocked(useOpenPdf).mockReturnValue(openPdfSpy)

    renderWithProviders(<App />)

    // The [pdfOpenId] effect opens the 'pdf' pane on the right dock.
    await waitFor(() => {
      expect(useDockStore.getState().right.openPaneIds).toContain('pdf')
    })

    // Single pane → quiet header close button. Clicking it must clear the id.
    const closeBtn = await screen.findByRole('button', { name: /close pdf/i })
    await act(async () => {
      fireEvent.click(closeBtn)
    })
    expect(openPdfSpy).toHaveBeenCalledWith(null)
  })
})

describe('App — onOpenPdf → source note create-or-resolve (B3)', () => {
  /**
   * B3 invariant: opening a PDF for the first time creates a type='source' note
   * (so the PDF appears in the feed); re-opening the same PDF (sha dedup at
   * pdf.import) must NOT create a duplicate note. The check is idempotent via
   * findSourceByPdfId. Empty body → uuid slug (collision-proof). @see spec §Data model
   * @see docs/specs/v0.6.4-notes-as-threads.md §Data model
   */
  const PDF_ID = 'pdf-b3-test'

  const PDF_SOURCE_NOTE: Note = {
    id: 'note-pdf-b3',
    slug: 'note-pdf-b3',
    body: '',
    type: 'source',
    created_at: 1000,
    updated_at: 1000,
    deleted_at: null,
    source_kind: 'pdf',
    source_locator: { media: 'pdf', pdf_id: PDF_ID },
  }

  beforeEach(() => {
    mockApi.system.chooseFile.mockResolvedValue({ filePaths: ['/docs/test.pdf'] })
    mockApi.pdf.import.mockResolvedValue({
      pdfId: PDF_ID,
      sha256: 'deadbeef',
      title: null,
      pageCount: null,
    })
    useCommandStore.getState().reset()
  })

  afterEach(() => {
    useCommandStore.getState().reset()
  })

  it('(a) opening a new PDF calls notes.create once with the right source shape', async () => {
    mockApi.notes.findSourceByPdfId.mockResolvedValueOnce(null)
    mockApi.notes.create.mockResolvedValueOnce(PDF_SOURCE_NOTE)

    renderWithProviders(<App />)
    await waitFor(() => expect(useCommandStore.getState().commands().length).toBeGreaterThan(0))

    await act(async () => {
      useCommandStore.getState().registry.get('pdf.open')?.run?.()
    })

    await waitFor(() =>
      expect(mockApi.notes.create).toHaveBeenCalledWith({
        body: '',
        type: 'source',
        source_kind: 'pdf',
        source_locator: { media: 'pdf', pdf_id: PDF_ID },
      }),
    )
    expect(mockApi.notes.create).toHaveBeenCalledOnce()
  })

  it('(b) re-opening an existing PDF does NOT call notes.create', async () => {
    mockApi.notes.findSourceByPdfId.mockResolvedValueOnce(PDF_SOURCE_NOTE)

    renderWithProviders(<App />)
    await waitFor(() => expect(useCommandStore.getState().commands().length).toBeGreaterThan(0))

    await act(async () => {
      useCommandStore.getState().registry.get('pdf.open')?.run?.()
    })

    await waitFor(() =>
      expect(mockApi.notes.findSourceByPdfId).toHaveBeenCalledWith({ pdfId: PDF_ID }),
    )
    expect(mockApi.notes.create).not.toHaveBeenCalled()
  })
})

describe('App — backlinks dock pane (spec §3,§4)', () => {
  beforeEach(() => {
    // Seed a focusable note so the Feed mock renders its focus trigger, and make
    // the backlinks body query resolve cleanly (both surfaces show the empty copy).
    mockApi.notes.list.mockResolvedValue([FEED_NOTE])
    mockApi.links.backlinks.mockResolvedValue([])
  })
  afterEach(() => useCommandStore.getState().reset())

  /** Focus a note via the Feed mock's per-note focus trigger (toggles on App side). */
  const focusNote = async (id: string) => {
    await act(async () => {
      fireEvent.click(await screen.findByTestId(`focus-btn-${id}`))
    })
  }

  it('registers backlinks.open only while a note is focused (absent → present → absent)', async () => {
    renderWithProviders(<App />)
    // Wait for the base command set to register so the registry is non-empty.
    await waitFor(() => expect(useCommandStore.getState().commands().length).toBeGreaterThan(0))
    const hasOpen = () =>
      useCommandStore
        .getState()
        .commands()
        .some((c) => c.id === 'backlinks.open')

    // No focus → command absent.
    expect(hasOpen()).toBe(false)

    // Focus a note → the dedicated [focusedId] effect registers it.
    await focusNote('feed-note-1')
    await waitFor(() => expect(hasOpen()).toBe(true))

    // Clear focus (re-click toggles off) → the effect cleanup unregisters it (C1).
    await focusNote('feed-note-1')
    await waitFor(() => expect(hasOpen()).toBe(false))
  })

  it('focusing a note opens the backlinks dock pane (single surface, no overlay)', async () => {
    renderWithProviders(<App />)
    await focusNote('feed-note-1')

    // Focus opens the dock pane directly (B6 / ADR 0047): the dock chrome's quiet
    // header close is present; the retired overlay's "close pane" never appears.
    await waitFor(() => expect(useDockStore.getState().right.openPaneIds).toContain('backlinks'))
    expect(await screen.findByLabelText(/close backlinks/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/close pane/i)).toBeNull()
    // Exactly one backlinks list body (the dock pane) — never two surfaces.
    expect(screen.queryAllByText(/nothing links here yet/i)).toHaveLength(1)
  })

  it('closing the dock pane clears focus and leaves no backlinks list (I1)', async () => {
    renderWithProviders(<App />)
    await focusNote('feed-note-1')
    const closeBtn = await screen.findByLabelText(/close backlinks/i)

    await act(async () => {
      fireEvent.click(closeBtn)
    })

    // I1: close clears focus; the feed sentinel reflects the cleared focus and the
    // pane does not resurrect (no list anywhere, pane removed from the store).
    await waitFor(() => expect(screen.queryByLabelText(/close backlinks/i)).toBeNull())
    expect(useDockStore.getState().right.openPaneIds).not.toContain('backlinks')
    expect(screen.getByTestId('feed-sentinel')).toHaveAttribute('data-focused-id', '')
    expect(screen.queryAllByText(/nothing links here yet/i)).toHaveLength(0)
  })

  it('clearing focus while the dock pane is open auto-closes the pane (I2)', async () => {
    renderWithProviders(<App />)
    await focusNote('feed-note-1')
    await screen.findByLabelText(/close backlinks/i)

    // Re-click the focused note → App toggles focus off → I2 closes the pane.
    await focusNote('feed-note-1')

    await waitFor(() =>
      expect(useDockStore.getState().right.openPaneIds).not.toContain('backlinks'),
    )
    expect(screen.queryByLabelText(/close backlinks/i)).toBeNull()
  })

  it('the Open-backlinks command run() opens the dock pane (⌘K wiring)', async () => {
    renderWithProviders(<App />)
    // Focus a note so the dedicated [focusedId] effect registers backlinks.open
    // (focusing also opens the pane via the coupling); close it so run() is the
    // thing that re-opens it, exercising the command's real closure in isolation.
    await focusNote('feed-note-1')
    await waitFor(() =>
      expect(
        useCommandStore
          .getState()
          .commands()
          .some((c) => c.id === 'backlinks.open'),
      ).toBe(true),
    )
    act(() => {
      useDockStore.getState().closePane('backlinks')
    })
    await waitFor(() =>
      expect(useDockStore.getState().right.openPaneIds).not.toContain('backlinks'),
    )

    // Drive the command end-to-end: resolve it from the registry and invoke its
    // real run() closure (the ⌘K "Open backlinks" wiring), not openPane directly.
    act(() => {
      useCommandStore.getState().registry.get('backlinks.open')?.run?.()
    })

    await waitFor(() => expect(useDockStore.getState().right.openPaneIds).toContain('backlinks'))
    expect(await screen.findByLabelText(/close backlinks/i)).toBeInTheDocument()
  })

  it('B2: the WindowFrame backlinks toggle opens the side independent of focus', async () => {
    renderWithProviders(<App />)
    // No note focused. The always-visible toggle opens the (fresh) right side anyway.
    const toggle = await screen.findByRole('button', { name: /toggle backlinks/i })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    await act(async () => {
      fireEvent.click(toggle)
    })
    await waitFor(() => expect(useDockStore.getState().right.openPaneIds).toContain('backlinks'))
    // Pane stays open with no focus (I2 only fires on a focus→null transition, not
    // when focus was already null), proving open-independent-of-focus.
    expect(await screen.findByLabelText(/close backlinks/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /toggle backlinks/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('B19: the side toggle COLLAPSES the whole right dock (remembering panes) and restores it', async () => {
    renderWithProviders(<App />)
    await focusNote('feed-note-1') // opens the right side (backlinks)
    expect(await screen.findByLabelText(/close backlinks/i)).toBeInTheDocument()

    // Top toggle → collapse the WHOLE side. The pane is REMEMBERED (still in
    // openPaneIds) and focus is preserved — only the dock is hidden.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /toggle backlinks/i }))
    })
    await waitFor(() => expect(screen.queryByLabelText(/close backlinks/i)).toBeNull())
    expect(useDockStore.getState().collapsed.right).toBe(true)
    expect(useDockStore.getState().right.openPaneIds).toContain('backlinks') // remembered
    expect(screen.getByRole('button', { name: /toggle backlinks/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    )

    // Toggle again → restore exactly what was there.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /toggle backlinks/i }))
    })
    expect(await screen.findByLabelText(/close backlinks/i)).toBeInTheDocument()
  })

  it('B19: explicit collapse wins over auto-open for the same note; a DIFFERENT note re-opens', async () => {
    mockApi.notes.list.mockResolvedValue([FEED_NOTE, { ...FEED_NOTE, id: 'feed-note-2' }])
    renderWithProviders(<App />)
    await focusNote('feed-note-1')
    await screen.findByLabelText(/close backlinks/i)

    // Collapse while feed-note-1 stays focused → the auto-open does NOT re-fire for
    // the same focus (the [focusedId] effect only runs on a focus change).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /toggle backlinks/i }))
    })
    await waitFor(() => expect(screen.queryByLabelText(/close backlinks/i)).toBeNull())
    expect(useDockStore.getState().collapsed.right).toBe(true)
    // Focus is preserved (collapse is not a close): the side is hidden despite a
    // focused note — proving the collapse suppresses auto-open for that note.
    expect(screen.getByTestId('feed-sentinel')).toHaveAttribute('data-focused-id', 'feed-note-1')

    // Focusing a DIFFERENT note re-opens the side (openPane clears the collapse).
    await focusNote('feed-note-2')
    expect(await screen.findByLabelText(/close backlinks/i)).toBeInTheDocument()
  })
})

describe('App — boot session gate + dock hydrate/persist (Task 1.6)', () => {
  /**
   * Boot hydrate: the persisted dock layout must reopen its UTILITY panes but never a
   * content pane empty — `hydrate` drops content-kind ids (a pdf/player re-opens from
   * its media context, not a restored id list). So a stored right side of ['pdf',
   * 'backlinks'] restores to just ['backlinks'].
   * @see src/renderer/src/panes/dockStore.ts hydrate
   * @see docs/specs/v0.7-session-persistence.md
   */
  it('boot restores dock layout (utility panes), not empty content panes', async () => {
    const mock = installMockApi()
    mock.settings.getMany.mockResolvedValue({
      values: {
        'dock.layout.v1': {
          left: { openPaneIds: ['shelf'], activeId: 'shelf' },
          right: { openPaneIds: ['pdf', 'backlinks'], activeId: 'pdf' },
          widths: {},
          collapsed: {},
        },
      },
    })
    renderWithProviders(<App />)
    await waitFor(() => expect(screen.getByTestId('dock-left')).toBeInTheDocument())
    expect(useDockStore.getState().left.openPaneIds).toContain('shelf')
    // 'pdf' is content-kind → dropped; only the utility 'backlinks' survives, re-pointed
    // as the right side's active pane (it was 'pdf', now filtered out).
    expect(useDockStore.getState().right.openPaneIds).toEqual(['backlinks'])
  })

  /**
   * FAIL-OPEN boot gate (carry-forward A): the boot gate keys on
   * `snap.isSuccess || snap.isError`, NOT `isSuccess` alone. When `settings.getMany`
   * rejects, the snapshot query never reaches `isSuccess`; gating on it alone would
   * hold the boot splash forever (permanent white screen). Asserting the snapshot-gated
   * feed placeholder appears proves boot still COMPLETES on the error path.
   */
  it('fail-open: a rejected getMany still completes boot (feed placeholder reveals, no hang)', async () => {
    const mock = installMockApi()
    mock.settings.getMany.mockRejectedValue(new Error('boom'))
    renderWithProviders(<App />)
    // The placeholder is gated on `snapSettled` (= isError here). If the gate were
    // isSuccess-only this findBy would time out — the test hanging IS the regression.
    expect(await screen.findByText(/nothing yet\. start anywhere\./i)).toBeInTheDocument()
  })
})

describe('App — session restore: focusedId / threadNoteId (Task 2.1)', () => {
  afterEach(() => useCommandStore.getState().reset())

  /**
   * Backlinks-suppression (the TRAP): the [focusedId] auto-open-backlinks effect calls
   * dock.openPane('backlinks') whenever focusedId becomes non-null, and openPane clears
   * the collapse flag for that side (dockStore.ts openPane → `collapsed[side]: false`). So
   * re-seeding a persisted focusedId at boot would clobber the just-hydrated dock — here it
   * would un-collapse the right side the user had collapsed. The restoredFocusRef guard makes
   * the effect skip exactly its first restore-sourced run, preserving collapsed.right === true.
   */
  it('restoring focusedId does not clear the hydrated collapse (backlinks-suppression)', async () => {
    const mock = installMockApi()
    mock.notes.get.mockResolvedValue({ id: 'n1' } as never)
    mock.settings.getMany.mockResolvedValue({
      values: {
        'dock.layout.v1': {
          left: { openPaneIds: [], activeId: null },
          right: { openPaneIds: ['backlinks'], activeId: 'backlinks' },
          widths: {},
          collapsed: { right: true },
        },
        'ui.session.v1': { focusedNoteId: 'n1', threadNoteId: null },
      },
    })
    renderWithProviders(<App />)
    await waitFor(() => expect(useDockStore.getState().hydrated).toBe(true))
    // Deterministically wait until the restored focus has propagated through BOTH [focusedId]
    // effects: the command-registration effect (registers 'backlinks.open') runs immediately
    // before the auto-open-backlinks effect in the SAME commit, so once 'backlinks.open' is
    // present the suppression effect has also run and collapsed.right is in its final state.
    await waitFor(() =>
      expect(
        useCommandStore
          .getState()
          .commands()
          .some((c) => c.id === 'backlinks.open'),
      ).toBe(true),
    )
    // backlinks is the ONLY right-side utility pane, so activeId cannot be "stolen" from
    // another pane — that assertion would be a tautology. The load-bearing guard is that
    // openPane('backlinks') must NOT clear the restored collapse; without restoredFocusRef the
    // [focusedId] effect flips collapsed.right false.
    expect(useDockStore.getState().collapsed.right).toBe(true)
  })

  /**
   * Thread precedence: when both a thread and a focus are persisted, the thread wins — the
   * restore opens the thread and IGNORES the focus (openThread itself clears focusedId). The
   * mocked ThreadView renders a back affordance, so its presence proves we're in a thread.
   */
  it('thread wins: both persisted → thread opens, focus ignored', async () => {
    const mock = installMockApi()
    mock.notes.get.mockResolvedValue({ id: 't1' } as never)
    mock.settings.getMany.mockResolvedValue({
      values: { 'ui.session.v1': { focusedNoteId: 'n1', threadNoteId: 't1' } },
    })
    renderWithProviders(<App />)
    // Anchored /^back$/i, not /back/i: the WindowFrame's always-present "toggle backlinks"
    // button also contains "back", so a loose regex would either false-match with no thread
    // open OR throw "multiple elements" once a thread IS open. The mocked ThreadView's leave-
    // thread control has the exact accessible name "back" (aria-label="back").
    await waitFor(() => expect(screen.getByRole('button', { name: /^back$/i })).toBeInTheDocument()) // in a thread
    // Precedence lock: the `return` after openThread means the focus-id get is never reached.
    // mock.notes.get is the raw window.api boundary, so the positional api.notes.get(id) wrapper
    // (lib/api.ts:65) records the IPC shape `{ id }`, not the bare string.
    expect(mock.notes.get).toHaveBeenCalledWith({ id: 't1' })
    expect(mock.notes.get).not.toHaveBeenCalledWith({ id: 'n1' })
  })
})

describe('App — thread scroll persist (Task 2.2)', () => {
  afterEach(() => useCommandStore.getState().reset())

  /**
   * App owns the per-root thread-scroll map and persists it to `thread.scroll.v1`. When a
   * (plain/pdf) ThreadView reports a scroll via onScroll, App keys it under threadNoteId and
   * the debounced writer persists the WHOLE map — OBJECT-FORM `settings.set({ key, value })`
   * (the renderer api wrapper reshapes the positional call). @see usePersistedWrite
   */
  it('persists thread.scroll.v1 (object-form) when the ThreadView reports a scroll', async () => {
    const mock = installMockApi()
    mock.notes.list.mockResolvedValue([FEED_NOTE])
    mock.system.getReconcileSkipped.mockResolvedValue(0)
    mock.settings.getMany.mockResolvedValue({ values: {} })

    renderWithProviders(<App />)

    // Open FEED_NOTE's thread via the mocked Feed → the ThreadView sentinel mounts.
    fireEvent.click(await screen.findByTestId('open-thread-btn-feed-note-1'))
    // Drive the sentinel's onScroll(240) report; App maps it under threadNoteId.
    fireEvent.click(await screen.findByTestId('thread-view-scroll'))

    await waitFor(() =>
      expect(mock.settings.set).toHaveBeenCalledWith({
        key: 'thread.scroll.v1',
        value: { 'feed-note-1': 240 },
      }),
    )
  })
})

describe('App — feed composer draft persist/restore (Task 4.1)', () => {
  afterEach(() => useCommandStore.getState().reset())

  /**
   * Boot restore: a persisted `composer.draft.feed.v1` seeds the create composer with BOTH the
   * body and the mode. App seeds `draftFeed` render-phase the instant the snapshot settles, and
   * the create composer is gated on `snapSettled` so it first-mounts with that seed present.
   */
  it('restores the feed draft (body + mode) from composer.draft.feed.v1 on boot', async () => {
    const mock = installMockApi()
    mock.notes.list.mockResolvedValue([])
    mock.system.getReconcileSkipped.mockResolvedValue(0)
    mock.settings.getMany.mockResolvedValue({
      values: { 'composer.draft.feed.v1': { body: 'a restored draft', mode: 'question' } },
    })

    renderWithProviders(<App />)

    const ta = (await screen.findByRole('textbox')) as HTMLTextAreaElement
    expect(ta.value).toBe('a restored draft')
    // question mode restored → the "QUESTION — ESC TO CLEAR" pill renders.
    expect(screen.getByText(/question/i)).toBeInTheDocument()
  })

  /**
   * Clear-and-cancel on send (the load-bearing bit): typing schedules a debounced draft write;
   * a send BEFORE that debounce elapses must CANCEL it and write null instead, so a late timer
   * can't resurrect the just-sent text. `usePersistedWrite` cancels a pending write whenever its
   * value changes, and createMut.onSuccess sets `draftFeed` to null → the pending {body:'sent…'}
   * write is dropped and a null clear is written. OBJECT-FORM `settings.set({ key, value })`.
   */
  it('cancels the pending draft write and persists null when a typed draft is sent', async () => {
    const mock = installMockApi()
    mock.notes.list.mockResolvedValue([])
    mock.system.getReconcileSkipped.mockResolvedValue(0)
    mock.settings.getMany.mockResolvedValue({ values: {} })
    mock.notes.create.mockResolvedValue({ ...FEED_NOTE, id: 'created-1' })

    renderWithProviders(<App />)

    const ta = await screen.findByRole('textbox')
    // Type → schedules a debounced write of { body: 'sent draft', mode: 'claim' } (400ms).
    fireEvent.change(ta, { target: { value: 'sent draft' } })
    // Send before the debounce fires → onSuccess sets draftFeed null → cancels the pending
    // draft write + schedules a null clear.
    await act(async () => {
      fireEvent.keyDown(ta, { key: 'Enter' })
    })

    // The null clear is written to the key…
    await waitFor(() =>
      expect(mock.settings.set).toHaveBeenCalledWith({
        key: 'composer.draft.feed.v1',
        value: null,
      }),
    )
    // …and the just-sent draft was NEVER persisted (its pending write was cancelled).
    expect(mock.settings.set).not.toHaveBeenCalledWith({
      key: 'composer.draft.feed.v1',
      value: { body: 'sent draft', mode: 'claim' },
    })
  })
})
