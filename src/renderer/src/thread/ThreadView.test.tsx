// @vitest-environment happy-dom
/**
 * Component tests for ThreadView shell.
 *
 * Heavy player is mocked out so tests run without a real YouTube iframe.
 * Assertions:
 *   (a) back button calls onClose
 *   (b) video title renders
 *   (c) SortPill toggles sortMode and changes note order
 *   (d) player host element is present in the DOM
 *
 * @see src/renderer/src/thread/ThreadView.tsx
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, type MockApi, renderWithProviders } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'

// Mock usePlayer so tests never touch the player singleton / iframe.
// `seekTo` is a shared spy and `currentTime` is read from a mutable holder so
// follow-scroll tests can advance the playhead between renders.
const seekTo = vi.fn()
const player = { seekTo, play: vi.fn(), pause: vi.fn() }
const playerState = { currentTime: 0 }
vi.mock('../yt/usePlayer', () => ({
  usePlayer: () => ({
    player,
    currentTime: playerState.currentTime,
    state: 'paused',
    duration: 100,
  }),
}))

// Mock the player singleton so the capture handler reads a deterministic rect +
// time without a real iframe. `getIframeRect` and `getCurrentTime` are reassigned
// per-test (the null-rect no-op case overrides getIframeRect).
const getIframeRect = vi.fn<() => DOMRect | null>(
  () => ({ x: 0, y: 0, width: 480, height: 270 }) as DOMRect,
)
const getCurrentTime = vi.fn<() => Promise<number>>(async () => 42)
vi.mock('../yt/playerSingleton', () => ({
  getPlayer: () => ({ getIframeRect, getCurrentTime, videoId: 'abc' }),
}))

// Import under test AFTER vi.mock so the hoisted mock applies.
import { ThreadView } from './ThreadView'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal source-type Note for api.notes.get */
const SOURCE_NOTE: Note = {
  id: 'v1',
  slug: 'vid',
  body: '',
  type: 'source',
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
  source_kind: 'youtube',
  source_locator: { media: 'youtube', video_id: 'abc' },
}

/** note-A: anchored at t=10, captured second (created_at=200) */
const NOTE_A: Note = {
  id: 'note-a',
  slug: 'note-a',
  body: 'note at ten seconds',
  type: 'claim',
  created_at: 200,
  updated_at: 200,
  deleted_at: null,
  source_kind: 'youtube',
  source_locator: { media: 'youtube', video_id: 'abc', t: 10 },
}

/** note-B: anchored at t=5, captured first (created_at=100) */
const NOTE_B: Note = {
  id: 'note-b',
  slug: 'note-b',
  body: 'note at five seconds',
  type: 'claim',
  created_at: 100,
  updated_at: 100,
  deleted_at: null,
  source_kind: 'youtube',
  source_locator: { media: 'youtube', video_id: 'abc', t: 5 },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let mockApi: MockApi

// jsdom lacks Element.prototype.scrollIntoView entirely (not even a no-op), so
// vi.spyOn can't attach to a missing property. Define it as a vi.fn() first so
// the follow-scroll + click-to-seek effects can assert it fired.
const scrollIntoView = vi.fn()
Element.prototype.scrollIntoView = scrollIntoView

beforeEach(() => {
  scrollIntoView.mockClear()
  playerState.currentTime = 0
  getIframeRect.mockReturnValue({ x: 0, y: 0, width: 480, height: 270 } as DOMRect)
  getCurrentTime.mockResolvedValue(42)
  mockApi = installMockApi()
  mockApi.notes.get.mockResolvedValue(SOURCE_NOTE)
  mockApi.links.commentsOf.mockResolvedValue([
    { note: NOTE_A, attachment: null },
    { note: NOTE_B, attachment: null },
  ])
  mockApi.videoSources.get.mockResolvedValue({
    title: 'My Video',
    channel: 'Chan',
    thumbnailUrl: null,
    durationSec: 100,
  })
  mockApi.videoSources.upsert.mockResolvedValue(undefined)
})

describe('ThreadView', () => {
  it('(a) back button calls onClose', async () => {
    const onClose = vi.fn()
    renderWithProviders(<ThreadView noteId="v1" onClose={onClose} />)
    // Wait for queries to settle (title loads after notes.get + videoSources.get)
    await waitFor(() => expect(screen.getByLabelText('back')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('back'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('(b) video title renders', async () => {
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())
  })

  it('(c) SortPill toggles mode and re-orders notes', async () => {
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)

    // Wait for data to load and notes to appear
    await waitFor(() => expect(screen.getByText('note at ten seconds')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('note at five seconds')).toBeInTheDocument())

    // Order is asserted via the rail's rendered note bodies in DOM order.
    const getOrder = () => screen.getAllByTestId('rail-note').map((el) => el.textContent?.trim())
    // In video-time mode: note-B (t=5, "five") before note-A (t=10, "ten")
    expect(getOrder()).toEqual(['note at five seconds', 'note at ten seconds'])

    const pill = screen.getByLabelText('sort mode')
    expect(pill).toBeInTheDocument()

    // Click to switch to capture mode. note-B created_at=100 < note-A created_at=200
    // → same [b, a] order here (both modes coincide for this data).
    fireEvent.click(pill)
    expect(screen.getByLabelText('sort mode')).toBeInTheDocument()
    expect(getOrder()).toEqual(['note at five seconds', 'note at ten seconds'])

    // Toggling back restores video order.
    fireEvent.click(pill)
    expect(getOrder()).toEqual(['note at five seconds', 'note at ten seconds'])
  })

  it('(d) player host element is in the DOM', async () => {
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('player-host')).toBeInTheDocument())
  })

  it('(c) SortPill: capture mode places earlier-captured note first when order differs', async () => {
    // Re-mock with reversed created_at so capture vs video order differs
    mockApi.links.commentsOf.mockResolvedValue([
      { note: { ...NOTE_A, created_at: 50 }, attachment: null }, // t=10, captured earlier
      { note: NOTE_B, attachment: null }, // t=5, captured later (100)
    ])

    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('note at ten seconds')).toBeInTheDocument())

    // Video mode: by t → note-B (t=5, "five") first, then note-A (t=10, "ten")
    const getOrder = () => screen.getAllByTestId('rail-note').map((el) => el.textContent?.trim())
    expect(getOrder()).toEqual(['note at five seconds', 'note at ten seconds'])

    // Switch to capture mode: note-A created_at=50 < note-B created_at=100 → note-A first
    fireEvent.click(screen.getByLabelText('sort mode'))
    expect(getOrder()).toEqual(['note at ten seconds', 'note at five seconds'])
  })
})

// ---------------------------------------------------------------------------
// Follow auto-scroll + click-to-seek (no reverse coupling)
// ---------------------------------------------------------------------------

describe('ThreadView follow-scroll + click-to-seek', () => {
  // Local render that keeps a stable QueryClient so `rerender` re-wraps in the
  // SAME provider (renderWithProviders allocates a fresh client internally, so
  // its `rerender` would drop the provider). Lets us advance the mocked
  // currentTime + force a re-render without toggling sort/follow.
  function renderThread() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // Fresh element each render so React doesn't bail out on a referentially
    // identical child; the mocked usePlayer re-reads playerState.currentTime.
    const ui = () => (
      <QueryClientProvider client={qc}>
        <ThreadView noteId="v1" onClose={() => {}} />
      </QueryClientProvider>
    )
    const result = render(ui())
    return { ...result, rerenderThread: () => result.rerender(ui()) }
  }

  it('clicking a Rail dot seeks to that cluster t AND scrolls the note into view', async () => {
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('note at five seconds')).toBeInTheDocument())

    scrollIntoView.mockClear()
    // First cluster dot is t=5 (NOTE_B sorts before NOTE_A in video mode).
    fireEvent.click(screen.getAllByTestId('rail-dot')[0] as Element)

    expect(seekTo).toHaveBeenCalledWith(5)
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('advancing currentTime past a cluster with followOn scrolls that cluster into view', async () => {
    const { rerenderThread } = renderThread()
    await waitFor(() => expect(screen.getByText('note at five seconds')).toBeInTheDocument())

    scrollIntoView.mockClear()
    // followOn defaults to true. Advance the playhead 0 → 7 so the active cluster
    // becomes idx 0 (t=5) and re-render (same provider, still video mode) so the
    // follow effect — keyed on [activeIdx, followOn] — fires scrollIntoView.
    playerState.currentTime = 7
    rerenderThread()

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
  })

  it('does NOT scroll on a currentTime change while followOn is false (no reverse coupling)', async () => {
    const { rerenderThread } = renderThread()
    await waitFor(() => expect(screen.getByText('note at five seconds')).toBeInTheDocument())

    // Turn follow OFF, then clear any scroll triggered while it was on.
    fireEvent.click(screen.getByRole('button', { name: /follow playback/i }))
    scrollIntoView.mockClear()

    // Advance the playhead past a cluster and re-render WITHOUT re-enabling
    // follow. With follow off, the note list must NOT auto-scroll.
    playerState.currentTime = 7
    rerenderThread()

    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Capture → pending chip → post comment-note + attachToNote
// ---------------------------------------------------------------------------

describe('ThreadView capture flow', () => {
  it('captures a frame, shows a pending chip, posts a comment-note anchored to the capture-t, then attaches', async () => {
    mockApi.youtube.capture.mockResolvedValue({
      id: 'att1',
      path: '/store/2026/05/sha.png',
      sha256: 'sha',
      width: 480,
      height: 270,
      devicePixelRatio: 1,
    })
    mockApi.notes.create.mockResolvedValue({ ...SOURCE_NOTE, id: 'n1', type: 'claim' })

    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    // Wait for the source note to resolve so videoId/slug are populated.
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())

    // (1) Camera button → capture called with the rect + videoId + t=42
    fireEvent.click(screen.getByLabelText('capture frame'))
    await waitFor(() => expect(mockApi.youtube.capture).toHaveBeenCalledOnce())
    expect(mockApi.youtube.capture).toHaveBeenCalledWith({
      rect: { x: 0, y: 0, width: 480, height: 270 },
      videoId: 'abc',
      t: 42,
    })

    // (2) the pending thumbnail chip appears with the derived _media URL
    await waitFor(() =>
      expect(screen.getByRole('img', { name: /frame/i })).toHaveAttribute(
        'src',
        '/_media/2026/05/sha.png',
      ),
    )

    // (3) type a caption + submit → notes.create with capture-t + commentOn slug
    //     + source_kind, THEN attachToNote('att1','n1') in that order.
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'look here' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    await waitFor(() => expect(mockApi.notes.create).toHaveBeenCalledOnce())
    expect(mockApi.notes.create).toHaveBeenCalledWith({
      body: 'look here',
      type: 'claim',
      source_kind: 'youtube',
      source_locator: { media: 'youtube', video_id: 'abc', t: 42 },
      commentOn: 'vid',
    })
    await waitFor(() => expect(mockApi.attachments.attachToNote).toHaveBeenCalledOnce())
    expect(mockApi.attachments.attachToNote).toHaveBeenCalledWith({
      attachmentId: 'att1',
      noteId: 'n1',
    })
    // create resolves before attach is invoked
    const createOrder = mockApi.notes.create.mock.invocationCallOrder[0] ?? Infinity
    const attachOrder = mockApi.attachments.attachToNote.mock.invocationCallOrder[0] ?? -Infinity
    expect(createOrder).toBeLessThan(attachOrder)

    // (4) after success the pending chip is gone
    await waitFor(() => expect(screen.queryByRole('img', { name: /frame/i })).toBeNull())
  })

  it('⌘⇧C hotkey fires capture when no form tag is focused', async () => {
    mockApi.youtube.capture.mockResolvedValue({
      id: 'att2',
      path: '/store/2026/05/x.png',
      sha256: 'x',
      width: 480,
      height: 270,
      devicePixelRatio: 1,
    })
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())

    // activeElement is body (no form tag) → enableOnFormTags omitted means the
    // hook is enabled here.
    fireEvent.keyDown(document.body, { key: 'c', code: 'KeyC', metaKey: true, shiftKey: true })
    fireEvent.keyDown(document.body, { key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(mockApi.youtube.capture).toHaveBeenCalled())
  })

  it('⌘⇧C hotkey does NOT fire while the composer textarea is focused (enableOnFormTags omitted)', async () => {
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())

    const textarea = screen.getByRole('textbox')
    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'c', code: 'KeyC', metaKey: true, shiftKey: true })
    fireEvent.keyDown(textarea, { key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true })

    // The hotkey is suppressed inside form tags → no capture.
    expect(mockApi.youtube.capture).not.toHaveBeenCalled()
  })

  it('is a no-op when getIframeRect() returns null (no crash, no capture call)', async () => {
    getIframeRect.mockReturnValue(null)
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('capture frame'))

    // No capture, no pending chip.
    expect(mockApi.youtube.capture).not.toHaveBeenCalled()
    expect(screen.queryByRole('img', { name: /frame/i })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Scroll-never-seeks invariant: dispatching a scroll event on the scroll
// container must NOT call player.seekTo (no scroll→playback coupling).
// ---------------------------------------------------------------------------

describe('ThreadView scroll-never-seeks invariant', () => {
  it('scroll event on the thread-scroll container does NOT call seekTo', async () => {
    seekTo.mockClear()
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)

    // Wait for data to settle so the container is mounted and measurePill's
    // onScroll handler is attached.
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())

    const scrollContainer = screen.getByTestId('thread-scroll')
    // Simulate a user scroll: set scrollTop then fire the scroll event.
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 200, writable: true })
    fireEvent.scroll(scrollContainer)

    // measurePill reads geometry (no-op in jsdom) — it must NEVER call seekTo.
    expect(seekTo).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// FIX 2: guard against empty commentOn when note hasn't loaded
// ---------------------------------------------------------------------------

describe('ThreadView FIX 2 — post guard when note not loaded', () => {
  it('does not call notes.create when note is null (commentOn guard throws)', async () => {
    // Override notes.get to return null so `note` never populates.
    mockApi.notes.get.mockResolvedValue(null)
    // Capture still works (videoId will be '' but the mock accepts anything).
    mockApi.youtube.capture.mockResolvedValue({
      id: 'att3',
      path: '/store/x.png',
      sha256: 'x',
      width: 480,
      height: 270,
      devicePixelRatio: 1,
    })

    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    // Wait for render to settle (title won't appear since videoSource has no title).
    await waitFor(() => expect(screen.getByLabelText('back')).toBeInTheDocument())

    // Trigger capture to get a pending frame, then try to post.
    fireEvent.click(screen.getByLabelText('capture frame'))
    await waitFor(() => expect(mockApi.youtube.capture).toHaveBeenCalled())

    // Type a caption and submit.
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'caption' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    // The mutationFn should throw before reaching notes.create.
    // Allow React Query a tick to process the mutation.
    await new Promise((r) => setTimeout(r, 50))
    expect(mockApi.notes.create).not.toHaveBeenCalled()
  })
})
