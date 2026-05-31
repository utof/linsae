// @vitest-environment jsdom
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

import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, type MockApi, renderWithProviders } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'

// Mock usePlayer so tests never touch the player singleton / iframe.
vi.mock('../yt/usePlayer', () => ({
  usePlayer: () => ({
    player: { seekTo: vi.fn(), play: vi.fn(), pause: vi.fn() },
    currentTime: 0,
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

beforeEach(() => {
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
