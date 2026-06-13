/**
 * Component tests for RecentPopover: list rendering, click-to-jump, close.
 * @see src/renderer/src/canvas/RecentPopover.tsx
 * @see docs/specs/v0.4-canvas-mvp.md §14
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, type MockApi, renderWithProviders } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'
import { RecentPopover } from './RecentPopover'

let mockApi: MockApi
const onClose = vi.fn()
const onJump = vi.fn()

const NOTE_A: Note = {
  id: 'note-a',
  slug: 'note-a',
  body: 'Alpha note body',
  type: 'claim',
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
}
const NOTE_B: Note = {
  id: 'note-b',
  slug: 'note-b',
  body: 'Beta note body',
  type: 'question',
  created_at: 2000,
  updated_at: 2000,
  deleted_at: null,
}

beforeEach(() => {
  mockApi = installMockApi()
  onClose.mockReset()
  onJump.mockReset()

  // Seed per-note caches so noteTitle resolves without a round-trip delay
  mockApi.notes.get.mockImplementation(async (id: unknown) => {
    const idStr = (id as { id?: string })?.id ?? id
    if (idStr === 'note-a') return NOTE_A
    if (idStr === 'note-b') return NOTE_B
    return null
  })

  mockApi.canvas.recentOnCanvas.mockResolvedValue([
    { noteId: 'note-a', kind: 'edited', at: Date.now() - 60_000 },
    { noteId: 'note-b', kind: 'created', at: Date.now() - 3_600_000 },
  ])
})

function renderPopover(open = true) {
  return renderWithProviders(<RecentPopover open={open} onClose={onClose} onJump={onJump} />)
}

describe('RecentPopover', () => {
  it('renders nothing when closed', () => {
    const { container } = renderPopover(false)
    expect(container.firstChild).toBeNull()
  })

  it('renders both recency labels when open', async () => {
    renderPopover()
    // Wait for the recentOnCanvas query to resolve
    await waitFor(() => expect(mockApi.canvas.recentOnCanvas).toHaveBeenCalled())
    // Labels come from recentLabel: "edited · 1m" and "created here · 1h"
    await waitFor(() => expect(screen.getByText(/edited/)).toBeInTheDocument())
    expect(screen.getByText(/created here/)).toBeInTheDocument()
  })

  it('clicking a row calls onJump(id) and onClose', async () => {
    renderPopover()
    await waitFor(() => expect(screen.getByText(/edited/)).toBeInTheDocument())

    // Click the first row (note-a)
    const rows = screen.getAllByRole('button')
    fireEvent.click(rows[0] as HTMLElement)
    expect(onJump).toHaveBeenCalledWith('note-a')
    expect(onClose).toHaveBeenCalled()
  })

  it('calls recentOnCanvas with correct args', async () => {
    renderPopover()
    await waitFor(() => expect(mockApi.canvas.recentOnCanvas).toHaveBeenCalled())
    expect(mockApi.canvas.recentOnCanvas).toHaveBeenCalledWith(
      expect.objectContaining({ canvasId: 'root', arrangementId: 'manual', limit: 8 }),
    )
  })
})
