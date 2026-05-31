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

    // In video-time mode: note-B (t=5) before note-A (t=10)
    const getOrder = () => {
      const items = screen.getAllByTestId('thread-note-item')
      return items.map((el) => el.getAttribute('data-note-id'))
    }
    expect(getOrder()).toEqual(['note-b', 'note-a'])

    // Toggle to capture-time mode: note-B (created_at=100) still first, note-A (created_at=200) second
    // But let's check the pill toggles the icon correctly AND re-orders
    const pill = screen.getByLabelText('sort mode')
    // In video mode, Film icon is shown — pill button exists
    expect(pill).toBeInTheDocument()

    // Click to switch to capture mode
    fireEvent.click(pill)

    // In capture mode: sorted by createdAt — note-B (100) before note-A (200), same order here
    // To observe a difference let's verify the Film icon changed to Clock
    // by checking the aria-label on the sort pill stays correct
    expect(screen.getByLabelText('sort mode')).toBeInTheDocument()

    // In capture mode: note-B created_at=100 < note-A created_at=200 → same order [b, a]
    // This is correct: both modes coincide for this data.
    // Let's also confirm toggling back restores video order
    fireEvent.click(pill)
    expect(getOrder()).toEqual(['note-b', 'note-a'])
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

    // Video mode: by t → note-B (t=5) first, then note-A (t=10)
    const getOrder = () =>
      screen.getAllByTestId('thread-note-item').map((el) => el.getAttribute('data-note-id'))
    expect(getOrder()).toEqual(['note-b', 'note-a'])

    // Switch to capture mode: note-A created_at=50 < note-B created_at=100 → note-A first
    fireEvent.click(screen.getByLabelText('sort mode'))
    expect(getOrder()).toEqual(['note-a', 'note-b'])
  })
})
