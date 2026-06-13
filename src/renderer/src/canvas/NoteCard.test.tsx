/**
 * Component tests for NoteCard: note body rendering, motion-LOD placeholder,
 * and individual-fetch fallback when the list cache does not hold the note.
 *
 * @see src/renderer/src/canvas/NoteCard.tsx
 * @see docs/specs/v0.4-canvas-mvp.md §3
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installMockApi, type MockApi } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'
import { NoteCard, type NoteCardProps } from './NoteCard'

let mockApi: MockApi

beforeEach(() => {
  mockApi = installMockApi()
})

const NOTE_ID = 'note-abc'
const NOTE_BODY = 'Hello **world** from canvas'
const NOTE_SLUG = 'hello-world'

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: NOTE_ID,
    slug: NOTE_SLUG,
    body: NOTE_BODY,
    type: 'claim',
    created_at: 1000,
    updated_at: 1000,
    deleted_at: null,
    ...overrides,
  }
}

const defaultProps: NoteCardProps = {
  noteId: NOTE_ID,
  x: 0,
  y: 0,
  keptAlive: false,
  isMoving: false,
  onMeasured: () => {},
  onWikilinkClick: () => {},
  resolveSlug: () => false,
  onBeginEdit: () => {},
  editing: false,
}

/**
 * Render a NoteCard inside its own QueryClient. Optionally pre-seed the
 * ['notes'] list cache with `seedNotes` so `placeholderData` seeding works.
 */
function renderCard(
  props: Partial<NoteCardProps> = {},
  opts: { seedNotes?: Note[]; qc?: QueryClient } = {},
): { container: HTMLElement; qc: QueryClient } {
  const qc = opts.qc ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (opts.seedNotes) {
    qc.setQueryData<Note[]>(['notes'], opts.seedNotes)
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const { container } = render(<NoteCard {...defaultProps} {...props} />, { wrapper })
  return { container, qc }
}

describe('NoteCard', () => {
  it('(a) renders full markdown body when idle with note seeded from list cache', async () => {
    const note = makeNote()
    // Seed the ['notes'] list cache — placeholderData seeding idiom
    mockApi.notes.get.mockResolvedValue(note)
    renderCard({}, { seedNotes: [note] })

    // The note body text should appear (rendered via Markdown)
    await waitFor(() => {
      expect(screen.getByText(/Hello/)).toBeTruthy()
    })
  })

  it('(b) renders placeholder title (from noteTitle) when isMoving and never-upgraded', async () => {
    const note = makeNote({ body: '# My Title\nsome content' })
    mockApi.notes.get.mockResolvedValue(note)
    renderCard({ isMoving: true }, { seedNotes: [note] })

    // noteTitle strips the '# ' prefix → 'My Title'
    await waitFor(() => {
      expect(screen.getByText('My Title')).toBeTruthy()
    })
    // The full markdown body ('some content') must NOT appear while moving
    // Note: 'My Title' is rendered as the title one-liner, not via Markdown
    expect(screen.queryByText('some content')).toBeNull()
  })

  it('(c) fetches individually when note is absent from list cache', async () => {
    const note = makeNote()
    mockApi.notes.get.mockResolvedValue(note)
    // No seedNotes — list cache is empty; card must fall back to individual fetch
    renderCard({}, { seedNotes: [] })

    // window.api.notes.get receives the IPC payload { id } (the api facade wraps
    // the positional arg: api.notes.get(id) → window.api.notes.get({ id }))
    await waitFor(() => {
      expect(mockApi.notes.get).toHaveBeenCalledWith({ id: NOTE_ID })
    })
    await waitFor(() => {
      expect(screen.getByText(/Hello/)).toBeTruthy()
    })
  })
})
