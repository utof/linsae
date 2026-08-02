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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushMicrotasks } from '../../../../tests/flush'
import { installMockApi, type MockApi, renderWithProviders } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'
import { serializeScene } from '../ink/svg'
import { useDockStore } from '../panes/dockStore'
import { useTransportStore } from '../yt/transportState'

/**
 * The transport store's own initial state, captured at module load — same technique
 * (and reason) as transportState.test.ts:18. MANDATORY: the `dom` project runs
 * `isolate: false` (vitest.config.ts:35), so this module singleton is shared across
 * files in a worker; a leaked `followOn: false` or a stale marker list would poison
 * transportState.test.ts's own INITIAL capture. (#203)
 */
const TRANSPORT_INITIAL = useTransportStore.getState()

// Mock usePlayerState so tests never touch the player singleton / rAF loop.
// `seekTo` is a shared spy and `currentTime` is read from a mutable holder so
// follow-scroll tests can advance the playhead between renders.
// After B5: ThreadView uses usePlayerState (read-only) — usePlayer lives in PlayerPane.
const seekTo = vi.fn()
const player = { seekTo, play: vi.fn(), pause: vi.fn(), mount: vi.fn(), unmount: vi.fn() }
const playerState = { currentTime: 0 }
vi.mock('../yt/usePlayerState', () => ({
  usePlayerState: () => ({
    player,
    currentTime: playerState.currentTime,
    state: 'paused',
    // Deliberately NOT 100. `markerPositions` returns `{ t, pct: (t / duration) * 100 }`
    // (rail-layout.ts:141), so at duration 100 `pct === t` identically and the marker
    // assertions below could not tell the two apart — publishing percentages instead of
    // seconds would have stayed green. At 200 the notes' t=5/10 give pct 2.5/5.
    duration: 200,
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
  // Reset dockStore so openPane('player') calls start from a clean slate (B5).
  useDockStore.getState().reset()
  // `setState(…, true)` REPLACES rather than merges, so no mutated field survives.
  useTransportStore.setState(TRANSPORT_INITIAL, true)
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

  it('(d) opening a youtube thread opens the player pane in dockStore; no in-body player-host', async () => {
    // B5: player placeholder moved to right-dock PlayerPane; ThreadView opens the pane.
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())

    // The 'player' pane should now be active in the right dock.
    await waitFor(() => expect(useDockStore.getState().right.activeId).toBe('player'))

    // ThreadView itself must NOT render the player-host div (it's in PlayerPane now).
    expect(screen.queryByTestId('player-host')).toBeNull()
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

  // The "turn follow OFF" case was dropped in B5 (`4ab51f0`) along with ThreadView's
  // TransportBar, and `followOn` was hardcoded `true` in its place. B3 restores it —
  // the toggle now lives on the TransportBar in the right-dock PlayerPane and reaches
  // this component through the shared transport store, so this asserts the real
  // cross-pane path, not a local useState.
  // The scroll-never-seeks invariant (scroll event ≠ seekTo) is covered by the
  // separate "scroll-never-seeks invariant" describe block below.
  it('with follow OFF in the store, advancing the playhead does NOT scroll (B3)', async () => {
    const { rerenderThread } = renderThread()
    await waitFor(() => expect(screen.getByText('note at five seconds')).toBeInTheDocument())

    // The PlayerPane's follow button does exactly this.
    act(() => {
      useTransportStore.getState().toggleFollow()
    })
    scrollIntoView.mockClear()

    playerState.currentTime = 7
    rerenderThread()
    await flushMicrotasks()

    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('the jump-to-now pill appears once follow is OFF (unreachable while followOn was hardcoded)', async () => {
    // `jumpPillDirection` returns null whenever `followOn` is true (rail-layout.ts:179),
    // so with ThreadView.tsx:260 hardcoded `true` this pill could never render in
    // production — the whole affordance has been dead since v0.6.4 B5.
    const { rerenderThread } = renderThread()
    await waitFor(() => expect(screen.getByText('note at five seconds')).toBeInTheDocument())
    expect(screen.queryByLabelText('jump to now')).toBeNull()

    act(() => {
      useTransportStore.getState().toggleFollow()
    })
    // Advance the playhead so an active cluster row exists for measurePill to measure
    // (activeIdx -1 → no row → pillDir stays null).
    playerState.currentTime = 7
    rerenderThread()

    await waitFor(() => expect(screen.getByLabelText('jump to now')).toBeInTheDocument())
    // Scope of this assertion: it proves the pill's RENDER PATH is reachable again,
    // NOT that 'up' vs 'down' is chosen correctly. happy-dom has no layout, so every
    // getBoundingClientRect() is all-zeros and `playheadY < viewTop + 8` is trivially
    // true — the pill always comes out 'up' here. The direction is real geometry and
    // belongs to the Electron smoke (B4).
  })
})

// ---------------------------------------------------------------------------
// B3 — ThreadView is the sole publisher of the transport store's markers (#169)
// ---------------------------------------------------------------------------

describe('ThreadView marker publishing (B3)', () => {
  it("publishes the thread's anchored timestamps, sorted and de-duplicated", async () => {
    // NOTE_B t=5, NOTE_A t=10 — SECONDS, not the `pct` field of the same objects
    // (which is 2.5/5 at the mocked duration of 200). TransportBar.tsx:184 derives
    // `left` from these itself, so publishing percentages would double-scale the ticks.
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(useTransportStore.getState().markers).toEqual([5, 10]))
  })

  it("CLEARS the markers on unmount, so one thread's ticks never appear on the next video", async () => {
    const { unmount } = renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(useTransportStore.getState().markers).toEqual([5, 10]))

    unmount()

    expect(useTransportStore.getState().markers).toEqual([])
  })

  it("publishes NO markers for a plain (non-video) thread, CLEARING a previous video's", async () => {
    // The generic branch has no anchored notes at all — publishing [] is what stops a
    // previous video's ticks from surviving on the docked scrubber while the docked
    // player keeps playing (markers are thread-scoped; followOn/rate are not).
    //
    // Seeded non-empty on purpose. Asserting `[]` against the `beforeEach` reset would
    // re-assert the value the harness just set: a publisher that skipped plain threads
    // entirely would pass. With ticks already on the scrubber, only a publisher that
    // actually runs for this branch can bring it back to empty.
    act(() => {
      useTransportStore.getState().setMarkers([5, 10])
    })

    mockApi.notes.get.mockResolvedValue({
      ...SOURCE_NOTE,
      source_kind: null,
      source_locator: null,
    } as unknown as Note)
    mockApi.links.commentsOf.mockResolvedValue([])

    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('thread-generic-scroll')).toBeInTheDocument())

    expect(useTransportStore.getState().markers).toEqual([])
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

  // FIX B: a RESTORED draft (seeded initialDraft, no frame, no manual time) posts
  // ANCHORLESS — the youtube locator must OMIT `t` entirely (not `t: null/undefined`).
  it('posts a restored draft ANCHORLESS — notes.create omits `t` in source_locator', async () => {
    mockApi.notes.create.mockResolvedValue({ ...SOURCE_NOTE, id: 'n2', type: 'claim' })

    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} initialDraft="restored note" />)
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())

    const textarea = screen.getByRole('textbox')
    // The draft is already seeded; press Enter to submit without adding a time.
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    await waitFor(() => expect(mockApi.notes.create).toHaveBeenCalledOnce())
    expect(mockApi.notes.create).toHaveBeenCalledWith({
      body: 'restored note',
      type: 'claim',
      source_kind: 'youtube',
      // No `t` key — anchorless. (deep-equal: an absent key must be truly absent.)
      source_locator: { media: 'youtube', video_id: 'abc' },
      commentOn: 'vid',
    })
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

  it('C3: two ⌘⇧C before the capture promise resolves → exactly ONE capture (async guard)', async () => {
    // The re-entrancy guard must hold across the await gap: editorOpen only flips
    // true after capture resolves, so a second hotkey in that window must be
    // blocked by an in-flight ref — otherwise a duplicate orphan row leaks.
    let resolveCapture: (v: {
      id: string
      path: string
      sha256: string
      width: number
      height: number
      devicePixelRatio: number
    }) => void = () => {}
    mockApi.youtube.capture.mockImplementation(
      () =>
        new Promise((res) => {
          resolveCapture = res
        }),
    )
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())

    // First click → capture is issued (and never resolves yet). Wait for it.
    fireEvent.click(screen.getByLabelText('capture frame'))
    await waitFor(() => expect(mockApi.youtube.capture).toHaveBeenCalledOnce())

    // A SECOND click while the first capture is still in flight must be a no-op
    // (the in-flight ref guards across the await gap, before editorOpen flips).
    fireEvent.click(screen.getByLabelText('capture frame'))
    // Let any (incorrect) second capture's await chain run.
    await new Promise((r) => setTimeout(r, 30))
    expect(mockApi.youtube.capture).toHaveBeenCalledOnce()

    // Resolve the first capture → editor opens; still exactly one capture.
    resolveCapture({
      id: 'att-once',
      path: '/store/2026/05/once.png',
      sha256: 'once',
      width: 480,
      height: 270,
      devicePixelRatio: 1,
    })
    await waitFor(() => expect(screen.getByTestId('annotate-editor')).toBeInTheDocument())
    expect(mockApi.youtube.capture).toHaveBeenCalledOnce()
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
    fireEvent.pointerDown(svgEl, {
      clientX: 10,
      clientY: 10,
      pointerType: 'mouse',
      pressure: 0.5,
      buttons: 1,
    })
    fireEvent.pointerMove(svgEl, {
      clientX: 20,
      clientY: 22,
      pointerType: 'mouse',
      pressure: 0.5,
      buttons: 1,
    })
    fireEvent.pointerMove(svgEl, {
      clientX: 40,
      clientY: 50,
      pointerType: 'mouse',
      pressure: 0.5,
      buttons: 1,
    })
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
    // findByRole, not getByRole: the prompt renders in response to the keydown, so a
    // synchronous query asserts it committed in the same tick. That raced ~1 run in 3.
    fireEvent.click(await screen.findByRole('button', { name: /^discard$/i }))

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
    fireEvent.pointerDown(svgEl, {
      clientX: 10,
      clientY: 10,
      pointerType: 'mouse',
      pressure: 0.5,
      buttons: 1,
    })
    fireEvent.pointerMove(svgEl, {
      clientX: 20,
      clientY: 22,
      pointerType: 'mouse',
      pressure: 0.5,
      buttons: 1,
    })
    fireEvent.pointerMove(svgEl, {
      clientX: 40,
      clientY: 50,
      pointerType: 'mouse',
      pressure: 0.5,
      buttons: 1,
    })
    fireEvent.pointerUp(svgEl, { clientX: 40, clientY: 50, pointerType: 'mouse', pressure: 0.5 })
    fireEvent.keyDown(window, { key: 'Escape' })
    // findByRole for the same reason as the discard case above — same prompt, same race.
    fireEvent.click(await screen.findByRole('button', { name: /keep as orphan/i }))

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
// Generic chronological thread (plain / pdf notes) — Task 2.3
// ---------------------------------------------------------------------------

/** Plain note with NO source_kind — triggers the generic branch. */
const PLAIN_NOTE: Note = {
  id: 'n1',
  slug: 'plain-note',
  body: 'root body',
  type: 'claim',
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
}

/** First child note (no timestamp anchor). */
const CHILD_ONE: Note = {
  id: 'c1',
  slug: 'c1',
  body: 'child one',
  type: 'claim',
  created_at: 1100,
  updated_at: 1100,
  deleted_at: null,
}

/** Second child note (no timestamp anchor). */
const CHILD_TWO: Note = {
  id: 'c2',
  slug: 'c2',
  body: 'child two',
  type: 'claim',
  created_at: 1200,
  updated_at: 1200,
  deleted_at: null,
}

describe('ThreadView generic thread (plain/pdf)', () => {
  it('renders a generic chronological thread for a plain note (no player, no sort pill)', async () => {
    // Override beforeEach defaults: resolve a plain note with two children (no `t`).
    mockApi.notes.get.mockResolvedValue(PLAIN_NOTE)
    mockApi.links.commentsOf.mockResolvedValue([
      { note: CHILD_ONE, attachment: null },
      { note: CHILD_TWO, attachment: null },
    ])

    renderWithProviders(<ThreadView noteId="n1" onClose={() => {}} />)

    // Children render via NoteBubble → Markdown pipeline.
    expect(await screen.findByText(/child one/)).toBeInTheDocument()
    // No sort pill (video/capture toggle is youtube-only).
    expect(screen.queryByRole('button', { name: /sort/i })).toBeNull()
    // SimpleComposer is present (renders a <textarea>).
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Empty-thread dividers (Task 3): a thread with NO children must render no
// stray horizontal rules — neither the ThreadRoot header rule nor the
// composer's top rule. Both return when there ARE children.
//
// happy-dom does no layout, so we assert the inline-style contract directly.
// A set border serializes to a non-empty `borderXStyle`; an unset border reads
// as ''. (happy-dom mis-parses the `var()` shorthand into the *-style longhand,
// but present-vs-absent is unambiguous, which is all this contract needs.)
// ---------------------------------------------------------------------------

describe('ThreadView empty-thread dividers (Task 3)', () => {
  it('an empty plain thread renders NO header divider and NO composer divider', async () => {
    mockApi.notes.get.mockResolvedValue(PLAIN_NOTE)
    mockApi.links.commentsOf.mockResolvedValue([])

    renderWithProviders(<ThreadView noteId="n1" onClose={() => {}} />)

    // The root header renders once the note loads.
    const root = await screen.findByTestId('thread-root')
    const composer = screen.getByTestId('thread-composer-region')

    expect(root.style.borderBottomStyle).toBe('')
    expect(composer.style.borderTopStyle).toBe('')
  })

  it('a plain thread WITH children keeps both dividers', async () => {
    mockApi.notes.get.mockResolvedValue(PLAIN_NOTE)
    mockApi.links.commentsOf.mockResolvedValue([
      { note: CHILD_ONE, attachment: null },
      { note: CHILD_TWO, attachment: null },
    ])

    renderWithProviders(<ThreadView noteId="n1" onClose={() => {}} />)

    // Wait for children to load so hasChildren flips true.
    await screen.findByText(/child one/)

    expect(screen.getByTestId('thread-root').style.borderBottomStyle).not.toBe('')
    expect(screen.getByTestId('thread-composer-region').style.borderTopStyle).not.toBe('')
  })
})

// ---------------------------------------------------------------------------
// Media-pane (re)open on thread-open — issue #166
// Opening a media note's thread MUST (re)open the corresponding dock pane,
// even if the user had explicitly closed it before.
// ---------------------------------------------------------------------------

/** PDF source note fixture — triggers the pdf branch in ThreadView. */
const PDF_SOURCE_NOTE: Note = {
  id: 'pdf-note-1',
  slug: 'my-pdf',
  body: '',
  type: 'source',
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
  source_kind: 'pdf',
  source_locator: { media: 'pdf', pdf_id: 'doc-p1' },
}

describe('ThreadView media-pane reopen on thread-open (#166)', () => {
  it('(e) opening a PDF note thread opens the pdf dock pane', async () => {
    mockApi.notes.get.mockResolvedValue(PDF_SOURCE_NOTE)
    mockApi.links.commentsOf.mockResolvedValue([])

    renderWithProviders(<ThreadView noteId="pdf-note-1" onClose={() => {}} />)

    // The 'pdf' pane must be opened in the right dock once the note loads.
    await waitFor(() => expect(useDockStore.getState().right.activeId).toBe('pdf'))
    expect(useDockStore.getState().right.openPaneIds).toContain('pdf')
  })

  it('(f) re-opening a PDF thread re-opens the pdf pane even after it was explicitly closed', async () => {
    // Why: issue #166 — the pane must re-appear even when the user had dismissed it.
    mockApi.notes.get.mockResolvedValue(PDF_SOURCE_NOTE)
    mockApi.links.commentsOf.mockResolvedValue([])

    const { unmount } = renderWithProviders(<ThreadView noteId="pdf-note-1" onClose={() => {}} />)
    // First open: pane appears.
    await waitFor(() => expect(useDockStore.getState().right.activeId).toBe('pdf'))

    // User explicitly closes the pane (simulates the dock × button).
    useDockStore.getState().closePane('pdf')
    expect(useDockStore.getState().right.activeId).not.toBe('pdf')

    // Navigate back to feed (unmount) then open the same thread again (remount).
    unmount()
    renderWithProviders(<ThreadView noteId="pdf-note-1" onClose={() => {}} />)

    // Pane must reappear even though it was closed between opens.
    await waitFor(() => expect(useDockStore.getState().right.activeId).toBe('pdf'))
  })

  it('(g) re-opening a YouTube thread re-opens the player pane even after it was explicitly closed', async () => {
    // Confirms the existing YouTube path handles re-open correctly (issue #166 check).
    const { unmount } = renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(useDockStore.getState().right.activeId).toBe('player'))

    // User closes the player pane.
    useDockStore.getState().closePane('player')
    expect(useDockStore.getState().right.activeId).not.toBe('player')

    // Navigate away + back → ThreadView remounts, effect fires again.
    unmount()
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)

    await waitFor(() => expect(useDockStore.getState().right.activeId).toBe('player'))
  })
})

// ---------------------------------------------------------------------------
// FIX 2: guard against empty commentOn when note hasn't loaded
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scroll restore/persist for the generic (plain/pdf) thread — Task 2.2 (v0.7).
// YouTube is EXCLUDED: its always-on playhead-follow (ThreadView follow effect)
// would clobber a restored offset every tick, so youtube uses the notesPane
// scroller which never reads initialScrollTop / attaches the persist listener.
// ---------------------------------------------------------------------------

describe('ThreadView scroll restore/persist (Task 2.2)', () => {
  it('restores initialScrollTop onto the generic (plain) scroller after children mount', async () => {
    mockApi.notes.get.mockResolvedValue(PLAIN_NOTE)
    mockApi.links.commentsOf.mockResolvedValue([
      { note: CHILD_ONE, attachment: null },
      { note: CHILD_TWO, attachment: null },
    ])

    renderWithProviders(<ThreadView noteId="n1" onClose={() => {}} initialScrollTop={250} />)

    // Restore is applied in a layout effect keyed on the child count (so it fires
    // AFTER children establish scrollHeight); wait for children then assert the set.
    const scroller = await screen.findByTestId('thread-generic-scroll')
    await waitFor(() => expect(scroller.scrollTop).toBe(250))
  })

  it('reports scrollTop via onScroll (trailing-throttled) when the generic scroller scrolls', async () => {
    mockApi.notes.get.mockResolvedValue(PLAIN_NOTE)
    mockApi.links.commentsOf.mockResolvedValue([
      { note: CHILD_ONE, attachment: null },
      { note: CHILD_TWO, attachment: null },
    ])
    const onScroll = vi.fn()

    renderWithProviders(<ThreadView noteId="n1" onClose={() => {}} onScroll={onScroll} />)

    const scroller = await screen.findByTestId('thread-generic-scroll')
    // happy-dom does no layout, but scrollTop is a settable property — set it, then
    // fire the scroll event; the trailing throttle reads it back off the element.
    Object.defineProperty(scroller, 'scrollTop', { value: 180, writable: true, configurable: true })
    fireEvent.scroll(scroller)

    await waitFor(() => expect(onScroll).toHaveBeenCalledWith(180))
  })

  it('a later initialScrollTop prop change does NOT re-apply scroll (echo-stomp regression)', async () => {
    // Mount-time snapshot, not reactive: on a thread with NO saved offset the user's own
    // scroll flows back down as initialScrollTop (onScroll → App map → prop). Reacting to
    // that prop change would yank the in-progress scroll to the stale offset. The restore
    // target is captured once at mount, so a later prop change must NOT move scrollTop.
    mockApi.notes.get.mockResolvedValue(PLAIN_NOTE)
    mockApi.links.commentsOf.mockResolvedValue([
      { note: CHILD_ONE, attachment: null },
      { note: CHILD_TWO, attachment: null },
    ])

    // Stable QueryClient so `rerender` updates the SAME ThreadView instance in place
    // (a fresh client would remount the tree and defeat the per-instance-snapshot premise).
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const ui = (scrollTop?: number) => (
      <QueryClientProvider client={qc}>
        <ThreadView noteId="n1" onClose={() => {}} initialScrollTop={scrollTop} />
      </QueryClientProvider>
    )
    // Mount with NO saved offset (undefined) — the no-saved-offset thread case.
    const { rerender } = render(ui(undefined))
    const scroller = await screen.findByTestId('thread-generic-scroll')
    await screen.findByText(/child one/)

    // Simulate the user's in-progress scroll.
    scroller.scrollTop = 260

    // The echo: App feeds the user's own scroll back down as initialScrollTop.
    rerender(ui(240))

    // A later prop change must NOT move scrollTop (mount-snapshot, not reactive).
    await new Promise((r) => setTimeout(r, 30))
    expect(scroller.scrollTop).toBe(260)
  })

  it('youtube thread IGNORES initialScrollTop (playhead-follow owns scroll)', async () => {
    // beforeEach default note is a youtube source → the notesPane scroller renders,
    // NOT the generic one. The youtube scroller must stay at 0 (never restored) and
    // there must be no generic scroller in a youtube thread.
    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} initialScrollTop={321} />)

    const scroller = await screen.findByTestId('thread-scroll')
    // Give any (incorrect) restore effect a tick to run before asserting untouched.
    await new Promise((r) => setTimeout(r, 30))
    expect(scroller.scrollTop).toBe(0)
    expect(screen.queryByTestId('thread-generic-scroll')).toBeNull()
  })
})

describe('ThreadView FIX 2 — post guard when note not loaded', () => {
  it('does not call notes.create when note is null, and does NOT eat the draft', async () => {
    // Override notes.get to return null so `note` never populates.
    // With branching: note=null → kind='plain' → generic branch renders with SimpleComposer.
    // postPlain guards on `!note?.slug`. v0.8.2 A3 turned that early `return` into a
    // THROW: a resolve here would let the clear-on-success composer clear the draft
    // with no note created — the same silent data-loss in a new place. Mirrors the
    // youtube path's `throw new Error('video note not loaded')` (ThreadView.tsx:509).
    // @issue utof/linsae#161
    mockApi.notes.get.mockResolvedValue(null)

    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    // Wait for render to settle — back button is always in the header.
    await waitFor(() => expect(screen.getByLabelText('back')).toBeInTheDocument())

    // The generic branch renders SimpleComposer (note=null → kind='plain').
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'caption' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    // The user is TOLD nothing happened…
    expect(await screen.findByRole('alert')).toHaveTextContent('note not loaded')
    await flushMicrotasks()
    // …no note was created…
    expect(mockApi.notes.create).not.toHaveBeenCalled()
    // …and the caption is still there to retry with.
    expect(textarea.value).toBe('caption')
  })
})

// ---------------------------------------------------------------------------
// v0.8.2 cluster A — a failed plain post must not destroy the user's text.
// `notes.create` is a real throw site: `save-note.ts:164` rejects with
// `a note named "<slug>" already exists` when two short identical replies
// collide on the body-derived slug.
// @issue utof/linsae#161 · @see docs/plans/v0.8.2-composer-dataloss.md §2
// ---------------------------------------------------------------------------

describe('ThreadView plain post failure (A3 — postPlain propagates)', () => {
  it('a rejected notes.create keeps the typed text and surfaces the error', async () => {
    mockApi.notes.get.mockResolvedValue(PLAIN_NOTE)
    mockApi.links.commentsOf.mockResolvedValue([])
    mockApi.notes.create.mockRejectedValue(new Error('a note named "yes" already exists'))

    renderWithProviders(<ThreadView noteId="n1" onClose={() => {}} />)
    // Wait for the ROOT BODY, not just the textarea: `postPlain` guards on
    // `note?.slug`, so submitting before the notes.get query settles would
    // exercise the not-loaded path instead of the create-rejects one.
    await screen.findByText(/root body/)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'yes' } })
    fireEvent.keyDown(ta, { key: 'Enter' })

    await waitFor(() => expect(mockApi.notes.create).toHaveBeenCalledOnce())
    // The rejection must reach the user, not just the console.
    expect(await screen.findByRole('alert')).toHaveTextContent('a note named "yes" already exists')
    await flushMicrotasks()
    expect(ta.value).toBe('yes')
  })

  it('a resolved notes.create clears the draft and shows no error', async () => {
    mockApi.notes.get.mockResolvedValue(PLAIN_NOTE)
    mockApi.links.commentsOf.mockResolvedValue([])
    mockApi.notes.create.mockResolvedValue({ ...CHILD_ONE, body: 'yes' })

    renderWithProviders(<ThreadView noteId="n1" onClose={() => {}} />)
    await screen.findByText(/root body/)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'yes' } })
    fireEvent.keyDown(ta, { key: 'Enter' })

    await waitFor(() => expect(mockApi.notes.create).toHaveBeenCalledOnce())
    await waitFor(() => expect(ta.value).toBe(''))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// v0.8.2 A4a — `onPost` must actually be AWAITABLE.
// TanStack Query v5's `mutate` returns `void`; only `mutateAsync` returns a
// promise that rejects. With `post.mutate` the composer's `await onPost(...)`
// awaits `undefined`, resolves on the next microtask and runs its success
// branch unconditionally — A4 would look done and clear the draft anyway.
// @issue utof/linsae#176 · @see docs/plans/v0.8.2-composer-dataloss.md §2.3 A4a
// ---------------------------------------------------------------------------

describe('ThreadView youtube post failure (A4a — onPost is awaited)', () => {
  it('a rejected notes.create keeps the typed caption and surfaces the error', async () => {
    mockApi.notes.create.mockRejectedValue(new Error('a note named "yes" already exists'))

    renderWithProviders(<ThreadView noteId="v1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('My Video')).toBeInTheDocument())

    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.focus(ta)
    fireEvent.change(ta, { target: { value: 'yes' } })
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false })

    await waitFor(() => expect(mockApi.notes.create).toHaveBeenCalledOnce())
    // The rejection must reach the user, not just the console.
    expect(await screen.findByRole('alert')).toHaveTextContent('a note named "yes" already exists')
    // …and the caption is still there to retry with. Hard negative — flush, not
    // waitFor: `mutate` would have cleared it exactly one microtask later.
    await flushMicrotasks()
    expect(ta.value).toBe('yes')
  })
})
