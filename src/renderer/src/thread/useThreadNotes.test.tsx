// @vitest-environment jsdom
/**
 * Component-level tests for `useThreadNotes`.
 *
 * Uses `renderHook` with a `QueryClientProvider` wrapper + `installMockApi` to
 * drive the hook without an Electron environment.
 *
 * @issue utof/linsae#36
 * @see src/renderer/src/thread/useThreadNotes.ts
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installMockApi } from '../../../../tests/setup'
import type { Attachment, Note } from '../../../shared/types'
import { useThreadNotes } from './useThreadNotes'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const baseNote = (id: string, overrides: Partial<Note> = {}): Note => ({
  id,
  slug: id,
  body: `body of ${id}`,
  type: 'claim',
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
  source_kind: 'youtube',
  source_locator: null,
  ...overrides,
})

const baseAttachment = (id: string): Attachment => ({
  id,
  note_id: id,
  kind: 'screenshot',
  base_sha256: `sha-${id}`,
  base_path: `/tmp/${id}.png`,
  overlay_path: null,
  video_id: 'vid1',
  time_seconds: 30,
  width_px: 1920,
  height_px: 1080,
  device_pixel_ratio: 2,
  created_at: 900,
  deleted_at: null,
})

// note-1: anchored at t=45, question type
const note1 = baseNote('note-1', {
  type: 'question',
  created_at: 100,
  source_locator: { media: 'youtube', video_id: 'vid1', t: 45 },
})
// note-2: anchorless (no t), claim type
const note2 = baseNote('note-2', {
  type: 'claim',
  created_at: 200,
  source_locator: { media: 'youtube', video_id: 'vid1' },
})

const attachment1 = baseAttachment('note-1')

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

function makeWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useThreadNotes', () => {
  let mock: ReturnType<typeof installMockApi>

  beforeEach(() => {
    mock = installMockApi()
    mock.links.commentsOf.mockResolvedValue([
      { note: note1, attachment: attachment1 },
      { note: note2, attachment: null },
    ])
  })

  it('exposes both notes once the query resolves', async () => {
    const { result } = renderHook(() => useThreadNotes('video-note-id', 'video'), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.noteCount).toBe(2)
  })

  it('video mode: anchored note (t=45) sorts before anchorless note', async () => {
    const { result } = renderHook(() => useThreadNotes('video-note-id', 'video'), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.sorted.map((i) => i.id)).toEqual(['note-1', 'note-2'])
  })

  it('capture mode: all notes sorted by createdAt asc', async () => {
    // note-1 created_at=100 < note-2 created_at=200 → same order, but sorted by createdAt
    const { result } = renderHook(() => useThreadNotes('video-note-id', 'capture'), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.sorted.map((i) => i.id)).toEqual(['note-1', 'note-2'])
  })

  it('capture mode with reversed createdAt re-orders correctly', async () => {
    // Override: note-2 has earlier createdAt
    const note2earlier = { ...note2, created_at: 50 }
    mock.links.commentsOf.mockResolvedValue([
      { note: note1, attachment: attachment1 },
      { note: note2earlier, attachment: null },
    ])
    const { result } = renderHook(() => useThreadNotes('video-note-id', 'capture'), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.sorted.map((i) => i.id)).toEqual(['note-2', 'note-1'])
  })

  it('anchorless bucket contains only the note with t===null', async () => {
    const { result } = renderHook(() => useThreadNotes('video-note-id', 'video'), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.anchorless.map((i) => i.id)).toEqual(['note-2'])
  })

  it('clusters the anchored note at t=45', async () => {
    const { result } = renderHook(() => useThreadNotes('video-note-id', 'video'), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.clusters).toHaveLength(1)
    expect(result.current.clusters[0]?.t).toBe(45)
    expect(result.current.clusters[0]?.notes.map((n) => n.id)).toEqual(['note-1'])
  })

  it('openQuestionCount counts only type===question notes', async () => {
    const { result } = renderHook(() => useThreadNotes('video-note-id', 'video'), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.openQuestionCount).toBe(1)
  })

  it('sorted items carry note and attachment fields', async () => {
    const { result } = renderHook(() => useThreadNotes('video-note-id', 'video'), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const first = result.current.sorted[0]
    expect(first?.note.id).toBe('note-1')
    expect(first?.attachment?.base_path).toBe('/tmp/note-1.png')
    const second = result.current.sorted[1]
    expect(second?.attachment).toBeNull()
  })

  it('calls api.links.commentsOf with the given videoNoteId', async () => {
    const { result } = renderHook(() => useThreadNotes('vid-abc', 'video'), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(mock.links.commentsOf).toHaveBeenCalledWith({ noteId: 'vid-abc' })
  })

  it('returns referentially stable sorted/clusters/anchorless across re-renders (regression #51)', async () => {
    // The thread playhead ticks ~5Hz (usePlayer); each tick re-renders the
    // consumer. If this hook rebuilds its derived arrays every render, every
    // Rail <Markdown> re-renders (+ re-parses KaTeX) on every tick. The derived
    // data must be memoized on the stable query result so identities survive
    // playhead-driven re-renders and the React Compiler can skip the bubbles.
    const { result, rerender } = renderHook(() => useThreadNotes('video-note-id', 'video'), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const first = result.current
    rerender() // simulate a parent re-render (playhead tick) with UNCHANGED data
    expect(result.current.sorted).toBe(first.sorted)
    expect(result.current.clusters).toBe(first.clusters)
    expect(result.current.anchorless).toBe(first.anchorless)
  })
})
