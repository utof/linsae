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
import { serializeScene } from '../ink/svg'

// Mock usePlayer so tests never touch the player singleton / iframe.
// `seekTo` is a shared spy and `currentTime` is read from a mutable holder so
// follow-scroll tests can advance the playhead between renders.
const seekTo = vi.fn()
const player = { seekTo, play: vi.fn(), pause: vi.fn(), mount: vi.fn(), unmount: vi.fn() }
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
// time without a real iframe. `getMediaRect` and `getCurrentTime` are reassigned
// per-test (the null-rect no-op case overrides getMediaRect).
const getMediaRect = vi.fn<() => DOMRect | null>(
  () => ({ x: 0, y: 0, width: 480, height: 270 }) as DOMRect,
)
const getCurrentTime = vi.fn<() => Promise<number>>(async () => 42)
vi.mock('../yt/playerSingleton', () => ({
  getPlayer: () => ({ getMediaRect, getCurrentTime, videoId: 'abc' }),
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
  getMediaRect.mockReturnValue({ x: 0, y: 0, width: 480, height: 270 } as DOMRect)
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

  it('toggles between stacked and split layouts', async () => {
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())
    // Stacked by default: horizontal resize handle present, vertical absent.
    expect(screen.getByTestId('player-resize')).toBeInTheDocument()
    expect(screen.queryByTestId('player-resize-v')).toBeNull()
    // Switch to split: vertical handle appears, horizontal goes away.
    fireEvent.click(screen.getByLabelText('toggle layout'))
    expect(screen.getByTestId('player-resize-v')).toBeInTheDocument()
    expect(screen.queryByTestId('player-resize')).toBeNull()
  })

  it('(c) SortPill toggles mode and re-orders notes', async () => {
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)

    // Wait for data to load and notes to appear
    await waitFor(() => expect(screen.getByText('note at ten seconds')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('note at five seconds')).toBeInTheDocument())

    // Order is asserted via the rail's rendered note bodies in DOM order.
    const getOrder = () =>
      screen.getAllByTestId('rail-note-body').map((el) => el.textContent?.trim())
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
    const getOrder = () =>
      screen.getAllByTestId('rail-note-body').map((el) => el.textContent?.trim())
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
// Capture → editor → pending chip → post comment-note + attachToNote (v0.2.5).
// UPDATED from v0.2.0: ⌘⇧C now OPENS THE EDITOR on the captured frame; Done
// produces the pending chip. These tests are updated (not deleted) for that step.
// ---------------------------------------------------------------------------

describe('ThreadView capture flow', () => {
  /** Drive the editor's Done button (the capture editor's primary chrome btn). */
  function clickDone() {
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }))
  }

  it('captures → opens editor → Done → pending chip → posts comment-note + attaches', async () => {
    mockApi.youtube.capture.mockResolvedValue({
      id: 'att1',
      path: '/store/2026/05/sha.png',
      sha256: 'sha',
      width: 480,
      height: 270,
      devicePixelRatio: 1,
    })
    mockApi.youtube.saveOverlay.mockResolvedValue({ overlayPath: null })
    mockApi.notes.create.mockResolvedValue({ ...SOURCE_NOTE, id: 'n1', type: 'claim' })

    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())

    // (1) Camera button → capture called with the rect + videoId + t=42
    fireEvent.click(screen.getByLabelText('capture frame'))
    await waitFor(() => expect(mockApi.youtube.capture).toHaveBeenCalledOnce())
    expect(mockApi.youtube.capture).toHaveBeenCalledWith({
      rect: { x: 0, y: 0, width: 480, height: 270 },
      videoId: 'abc',
      t: 42,
    })

    // (2) the editor opens on the captured frame (NOT the chip yet — v0.2.5)
    await waitFor(() => expect(screen.getByTestId('annotate-editor')).toBeInTheDocument())
    expect(screen.queryByRole('img', { name: /^captured frame$/i })).toBeNull()

    // (3) Done (empty scene) → editor closes → the pending chip appears with the
    //     base frame (AnnotatedFrame, /_media/<sha>). v0.2.0 parity: no overlay.
    clickDone()
    await waitFor(() => expect(screen.queryByTestId('annotate-editor')).toBeNull())
    await waitFor(() =>
      expect(screen.getByRole('img', { name: /captured frame/i })).toHaveAttribute(
        'src',
        '/_media/2026/05/sha.png',
      ),
    )

    // (4) type a caption + submit → notes.create with capture-t + commentOn slug
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
    const createOrder = mockApi.notes.create.mock.invocationCallOrder[0] ?? Infinity
    const attachOrder = mockApi.attachments.attachToNote.mock.invocationCallOrder[0] ?? -Infinity
    expect(createOrder).toBeLessThan(attachOrder)

    // (5) after success the pending chip is gone
    await waitFor(() => expect(screen.queryByRole('img', { name: /captured frame/i })).toBeNull())
  })

  it('⌘⇧C hotkey fires capture (and opens the editor) when no form tag is focused', async () => {
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
    // hook is enabled here. Fire both the meta (mac) and ctrl (win/linux) forms.
    fireEvent.keyDown(document.body, { key: 'c', code: 'KeyC', metaKey: true, shiftKey: true })
    fireEvent.keyDown(document.body, { key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(mockApi.youtube.capture).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('annotate-editor')).toBeInTheDocument())
  })

  it('⌘⇧C while the editor is already open is a no-op (re-entrancy guard)', async () => {
    mockApi.youtube.capture.mockResolvedValue({
      id: 'att-guard',
      path: '/store/2026/05/g.png',
      sha256: 'g',
      width: 480,
      height: 270,
      devicePixelRatio: 1,
    })
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())

    // First capture opens the editor.
    fireEvent.click(screen.getByLabelText('capture frame'))
    await waitFor(() => expect(screen.getByTestId('annotate-editor')).toBeInTheDocument())
    expect(mockApi.youtube.capture).toHaveBeenCalledOnce()

    // A second ⌘⇧C while the editor is open must NOT capture again (both forms).
    fireEvent.keyDown(document.body, { key: 'c', code: 'KeyC', metaKey: true, shiftKey: true })
    fireEvent.keyDown(document.body, { key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true })
    // Give any async capture a tick; the guard means no second call.
    await new Promise((r) => setTimeout(r, 30))
    expect(mockApi.youtube.capture).toHaveBeenCalledOnce()
  })

  it('Done with a NON-empty scene → chip frame carries the saved overlay_path', async () => {
    mockApi.youtube.capture.mockResolvedValue({
      id: 'att-drawn',
      path: '/store/2026/05/d.png',
      sha256: 'd',
      width: 480,
      height: 270,
      devicePixelRatio: 1,
    })
    mockApi.youtube.saveOverlay.mockResolvedValue({ overlayPath: '/store/2026/05/att-drawn.svg' })
    // The chip's AnnotatedFrame will fetch the overlay sidecar — return a parseable scene.
    const svg = serializeScene({ width: 480, height: 270, elements: [] })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(svg, { status: 200 }))

    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('capture frame'))
    await waitFor(() => expect(screen.getByTestId('annotate-editor')).toBeInTheDocument())

    // Draw a stroke, then Done.
    const svgEl = document.querySelector('svg[aria-label="Annotation overlay"]') as Element
    fireEvent.pointerDown(svgEl, { clientX: 10, clientY: 10, pointerType: 'mouse', pressure: 0.5 })
    fireEvent.pointerMove(svgEl, { clientX: 20, clientY: 22, pointerType: 'mouse', pressure: 0.5 })
    fireEvent.pointerMove(svgEl, { clientX: 40, clientY: 50, pointerType: 'mouse', pressure: 0.5 })
    fireEvent.pointerUp(svgEl, { clientX: 40, clientY: 50, pointerType: 'mouse', pressure: 0.5 })
    clickDone()

    // saveOverlay was called with a real SVG (non-empty scene).
    await waitFor(() => expect(mockApi.youtube.saveOverlay).toHaveBeenCalled())
    expect(typeof mockApi.youtube.saveOverlay.mock.calls[0]?.[0].svg).toBe('string')
    // The chip appears (base frame from the synthesized attachment).
    await waitFor(() =>
      expect(screen.getByRole('img', { name: /captured frame/i })).toHaveAttribute(
        'src',
        '/_media/2026/05/d.png',
      ),
    )
  })

  it('Esc → Discard (never posted) calls attachments.remove and shows no chip', async () => {
    mockApi.youtube.capture.mockResolvedValue({
      id: 'att-disc',
      path: '/store/2026/05/disc.png',
      sha256: 'disc',
      width: 480,
      height: 270,
      devicePixelRatio: 1,
    })
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('capture frame'))
    await waitFor(() => expect(screen.getByTestId('annotate-editor')).toBeInTheDocument())

    // Esc → discard/keep-orphan prompt → Discard.
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: /^discard$/i }))

    await waitFor(() => expect(mockApi.attachments.remove).toHaveBeenCalledWith({ id: 'att-disc' }))
    // No chip after discard.
    await waitFor(() => expect(screen.queryByTestId('annotate-editor')).toBeNull())
    expect(screen.queryByRole('img', { name: /captured frame/i })).toBeNull()
  })

  it('Esc → Keep (non-empty) saves the scene and leaves an orphan — NO chip staged', async () => {
    // Spec §Key flows: Keep saves the drawing (so it is not lost) then LEAVES the
    // orphan row for the future orphan tray — it does NOT stage the pending chip
    // (that is what Done does). The capture row already exists (note_id:null) and
    // simply persists: not removed, not staged.
    mockApi.youtube.capture.mockResolvedValue({
      id: 'att-keep',
      path: '/store/2026/05/keep.png',
      sha256: 'keep',
      width: 480,
      height: 270,
      devicePixelRatio: 1,
    })
    mockApi.youtube.saveOverlay.mockResolvedValue({ overlayPath: '/store/2026/05/att-keep.svg' })

    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('capture frame'))
    await waitFor(() => expect(screen.getByTestId('annotate-editor')).toBeInTheDocument())

    // Draw, then Esc → Keep as orphan.
    const svgEl = document.querySelector('svg[aria-label="Annotation overlay"]') as Element
    fireEvent.pointerDown(svgEl, { clientX: 10, clientY: 10, pointerType: 'mouse', pressure: 0.5 })
    fireEvent.pointerMove(svgEl, { clientX: 20, clientY: 22, pointerType: 'mouse', pressure: 0.5 })
    fireEvent.pointerMove(svgEl, { clientX: 40, clientY: 50, pointerType: 'mouse', pressure: 0.5 })
    fireEvent.pointerUp(svgEl, { clientX: 40, clientY: 50, pointerType: 'mouse', pressure: 0.5 })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: /keep as orphan/i }))

    // (a) the drawing was saved (non-empty scene → serialized svg)
    await waitFor(() => expect(mockApi.youtube.saveOverlay).toHaveBeenCalled())
    expect(typeof mockApi.youtube.saveOverlay.mock.calls[0]?.[0].svg).toBe('string')
    // editor closes
    await waitFor(() => expect(screen.queryByTestId('annotate-editor')).toBeNull())
    // (b) NO pending chip is staged in the composer (contrast Done) ...
    expect(screen.queryByRole('img', { name: /captured frame/i })).toBeNull()
    // ... and the orphan attachment was NOT removed (contrast Discard).
    expect(mockApi.attachments.remove).not.toHaveBeenCalled()
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

  it('is a no-op when getMediaRect() returns null (no crash, no capture call, no editor)', async () => {
    getMediaRect.mockReturnValue(null)
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('capture frame'))

    // No capture, no editor, no pending chip.
    expect(mockApi.youtube.capture).not.toHaveBeenCalled()
    expect(screen.queryByTestId('annotate-editor')).toBeNull()
    expect(screen.queryByRole('img', { name: /captured frame/i })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Reopen a posted screenshot (T4.2): hover-pencil on a Rail frame opens the
// editor modal for that attachment.
// ---------------------------------------------------------------------------

describe('ThreadView reopen flow', () => {
  const SCREENSHOT = {
    id: 'att-r1',
    note_id: 'note-a',
    kind: 'screenshot' as const,
    base_sha256: 'sha',
    base_path: '/store/2026/05/sha.png',
    overlay_path: null,
    video_id: 'abc',
    time_seconds: 10,
    width_px: 1920,
    height_px: 1080,
    device_pixel_ratio: 1,
    created_at: 200,
    deleted_at: null,
  }

  it('clicking the frame pencil opens the annotation editor modal', async () => {
    mockApi.links.commentsOf.mockResolvedValue([{ note: NOTE_A, attachment: SCREENSHOT }])

    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('annotated-frame-reopen')).toBeInTheDocument())

    // No editor modal until the pencil is clicked.
    expect(screen.queryByTestId('annotate-editor')).toBeNull()
    fireEvent.click(screen.getByTestId('annotated-frame-reopen'))

    // ReopenEditor resolves the (null) overlay then mounts AnnotateEditor.
    await waitFor(() => expect(screen.getByTestId('annotate-editor')).toBeInTheDocument())
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
    mockApi.youtube.saveOverlay.mockResolvedValue({ overlayPath: null })

    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    // Wait for render to settle (title won't appear since videoSource has no title).
    await waitFor(() => expect(screen.getByLabelText('back')).toBeInTheDocument())

    // Trigger capture → editor opens → Done (empty) → pending chip, then try to post.
    fireEvent.click(screen.getByLabelText('capture frame'))
    await waitFor(() => expect(screen.getByTestId('annotate-editor')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }))
    await waitFor(() => expect(screen.queryByTestId('annotate-editor')).toBeNull())

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
