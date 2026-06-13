/**
 * Component tests for the canvas `/` Picker: FTS search rows, keymap
 * (`↵` / `⇧↵` / `esc`), ▦ jump-not-duplicate, and footer hint text.
 *
 * @see src/renderer/src/canvas/Picker.tsx
 * @see docs/specs/v0.4-canvas-mvp.md §5
 * @see docs/plans/v0.4-canvas-mvp-3-placement-chrome.md Task 5 Step 1
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, type MockApi, renderWithProviders } from '../../../../tests/setup'
import type { SearchHit } from '../../../shared/types'
import { Picker } from './Picker'

let mockApi: MockApi
const onPick = vi.fn()
const onJump = vi.fn()
const onClose = vi.fn()

const PLACED_ID = 'placed-note-1'
const UNPLACED_ID = 'unplaced-note-2'
const placedNoteIds = new Set([PLACED_ID])

const hits: SearchHit[] = [
  {
    note: {
      id: UNPLACED_ID,
      slug: 'unplaced-note',
      body: 'Unplaced note body',
      type: 'claim',
      created_at: 1000,
      updated_at: 1000,
      deleted_at: null,
    },
    snippet: 'Unplaced note body',
    rank: -1,
  },
  {
    note: {
      id: PLACED_ID,
      slug: 'placed-note',
      body: 'Placed note body',
      type: 'question',
      created_at: 2000,
      updated_at: 2000,
      deleted_at: null,
    },
    snippet: 'Placed note body',
    rank: -2,
  },
]

beforeEach(() => {
  mockApi = installMockApi()
  onPick.mockReset()
  onJump.mockReset()
  onClose.mockReset()
})

function renderPicker(placedIds: ReadonlySet<string> = placedNoteIds) {
  return renderWithProviders(
    <Picker
      anchor={{ x: 100, y: 200 }}
      placedNoteIds={placedIds}
      onPick={onPick}
      onJump={onJump}
      onClose={onClose}
    />,
  )
}

describe('Picker', () => {
  it('renders the search input', () => {
    renderPicker()
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('shows rows for both hits after typing a query', async () => {
    mockApi.search.run.mockResolvedValueOnce(hits)
    renderPicker()
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'note' } })
    await waitFor(() => expect(mockApi.search.run).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('Unplaced note body')).toBeInTheDocument())
    expect(screen.getByText('Placed note body')).toBeInTheDocument()
  })

  it('hides stale rows when the query is cleared to empty', async () => {
    // enabled:query>0 makes react-query RETAIN the last results when the query
    // goes empty; gating the row map on query.length>0 must hide them so the
    // "type to search" empty state stands alone (and Task 8's Shift+Enter
    // cascade, which clears the query while keeping the picker open, is clean).
    mockApi.search.run.mockResolvedValueOnce(hits)
    renderPicker()
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'note' } })
    await waitFor(() => expect(screen.getByText('Unplaced note body')).toBeInTheDocument())
    // Backspace the query to empty
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(screen.getByText('type to search…')).toBeInTheDocument())
    expect(screen.queryByText('Unplaced note body')).not.toBeInTheDocument()
    expect(screen.queryByText('Placed note body')).not.toBeInTheDocument()
  })

  it('shows a ▦ chip on the placed row', async () => {
    mockApi.search.run.mockResolvedValueOnce(hits)
    renderPicker()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'note' } })
    await waitFor(() => expect(screen.getByText('Placed note body')).toBeInTheDocument())
    // The placed row should render a ▦ chip
    const chips = screen.getAllByText('▦')
    expect(chips.length).toBeGreaterThanOrEqual(1)
  })

  it('Enter on unplaced row calls onPick(id, {keepOpen:false})', async () => {
    mockApi.search.run.mockResolvedValueOnce(hits)
    renderPicker()
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'note' } })
    await waitFor(() => expect(screen.getByText('Unplaced note body')).toBeInTheDocument())

    // Fire Enter (no shift) on the input
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })
    expect(onPick).toHaveBeenCalledWith(UNPLACED_ID, { keepOpen: false })
    expect(onJump).not.toHaveBeenCalled()
  })

  it('Shift+Enter on unplaced row calls onPick(id, {keepOpen:true})', async () => {
    mockApi.search.run.mockResolvedValueOnce(hits)
    renderPicker()
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'note' } })
    await waitFor(() => expect(screen.getByText('Unplaced note body')).toBeInTheDocument())

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onPick).toHaveBeenCalledWith(UNPLACED_ID, { keepOpen: true })
    expect(onJump).not.toHaveBeenCalled()
  })

  it('Enter on placed row calls onJump(id) — jump-not-duplicate (§5)', async () => {
    // Return only the placed hit so it's first (and auto-highlighted)
    mockApi.search.run.mockResolvedValueOnce([hits[1]])
    renderPicker()
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'placed' } })
    await waitFor(() => expect(screen.getByText('Placed note body')).toBeInTheDocument())

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })
    expect(onJump).toHaveBeenCalledWith(PLACED_ID)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('Escape calls onClose and stops propagation', () => {
    renderPicker()
    const input = screen.getByRole('combobox')
    const escEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    const stopPropagation = vi.spyOn(escEvent, 'stopPropagation')
    input.dispatchEvent(escEvent)
    expect(onClose).toHaveBeenCalled()
    expect(stopPropagation).toHaveBeenCalled()
  })

  it('renders footer hint text verbatim', () => {
    renderPicker()
    expect(screen.getByText('↵ place here · ⇧↵ place + keep picker · esc')).toBeInTheDocument()
  })
})
