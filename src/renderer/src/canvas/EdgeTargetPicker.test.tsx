/**
 * Component tests for the canvas edge-target picker (drop-in-empty, spec §4):
 * fuzzy-ranked rows over live notes, matched-char highlight, ▦-placed connect,
 * place-existing vs create-new routing, and `esc` close.
 *
 * Mirrors Picker.test.tsx's RTL approach for cmdk-in-happy-dom (controlled
 * `value`, `fireEvent.change` to type, `fireEvent.keyDown` for Enter/Esc).
 *
 * @see src/renderer/src/canvas/EdgeTargetPicker.tsx
 * @see docs/specs/v0.4.1-canvas-edges.md §4
 * @see docs/plans/v0.4.1-canvas-edges.md Task 7 Step 1
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, type MockApi, renderWithProviders } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'
import { EdgeTargetPicker } from './EdgeTargetPicker'

let mockApi: MockApi
const onConnectExisting = vi.fn()
const onPlaceAndConnect = vi.fn()
const onCreateAndConnect = vi.fn()
const onClose = vi.fn()

const PLACED_ID = 'placed-note-1'
const UNPLACED_ID = 'unplaced-note-2'
const placedNoteIds = new Set([PLACED_ID])

function note(id: string, body: string): Note {
  return {
    id,
    slug: id,
    body,
    type: 'claim',
    created_at: 1000,
    updated_at: 1000,
    deleted_at: null,
  }
}

// `claude` is the fuzzy target for `cu` (subsequence); `Placed thing` is the
// already-placed row; `Random other` is filtered out by a `cu` query.
const notes: Note[] = [
  note(UNPLACED_ID, 'claude shannon'),
  note(PLACED_ID, 'Placed thing'),
  note('other-3', 'Random other'),
]

beforeEach(() => {
  mockApi = installMockApi()
  mockApi.notes.list.mockResolvedValue(notes)
  onConnectExisting.mockReset()
  onPlaceAndConnect.mockReset()
  onCreateAndConnect.mockReset()
  onClose.mockReset()
})

function renderPicker(placedIds: ReadonlySet<string> = placedNoteIds) {
  return renderWithProviders(
    <EdgeTargetPicker
      anchor={{ x: 100, y: 200 }}
      placedNoteIds={placedIds}
      onConnectExisting={onConnectExisting}
      onPlaceAndConnect={onPlaceAndConnect}
      onCreateAndConnect={onCreateAndConnect}
      onClose={onClose}
    />,
  )
}

/** Wait for the note list to resolve into the query cache (rows render on data). */
async function waitForNotes() {
  await waitFor(() => expect(mockApi.notes.list).toHaveBeenCalled())
}

describe('EdgeTargetPicker', () => {
  it('renders the search input', () => {
    renderPicker()
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('(a) typing fuzzy-filters + ranks and highlights matched chars', async () => {
    renderPicker()
    await waitForNotes()
    const input = screen.getByRole('combobox')
    // `cu` is a subsequence of `claude` but not of `Placed thing`/`Random other`.
    fireEvent.change(input, { target: { value: 'cu' } })

    await waitFor(() => expect(screen.getByText('shannon', { exact: false })).toBeInTheDocument())
    // The non-matching rows are gone.
    expect(screen.queryByText('Placed thing')).not.toBeInTheDocument()
    expect(screen.queryByText('Random other')).not.toBeInTheDocument()
    // Matched chars are wrapped in <mark> elements (the `c` and `u` of `claude`).
    const marks = document.querySelectorAll('mark')
    expect(marks.length).toBeGreaterThanOrEqual(2)
    expect(marks[0]?.textContent).toBe('c')
  })

  it('(b) Enter on an existing UNPLACED row calls onPlaceAndConnect(id)', async () => {
    renderPicker()
    await waitForNotes()
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'cu' } })
    await waitFor(() => expect(screen.getByText('shannon', { exact: false })).toBeInTheDocument())

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPlaceAndConnect).toHaveBeenCalledWith(UNPLACED_ID)
    expect(onConnectExisting).not.toHaveBeenCalled()
    expect(onCreateAndConnect).not.toHaveBeenCalled()
  })

  it('(c) Enter on an already-placed (▦) row calls onConnectExisting(id), no re-place', async () => {
    renderPicker()
    await waitForNotes()
    const input = screen.getByRole('combobox')
    // `placed` matches only the placed row → it's first + auto-highlighted.
    fireEvent.change(input, { target: { value: 'placed' } })
    await waitFor(() => expect(screen.getByText('thing', { exact: false })).toBeInTheDocument())
    // ▦ chip shows for the placed row.
    expect(screen.getAllByText('▦').length).toBeGreaterThanOrEqual(1)

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConnectExisting).toHaveBeenCalledWith(PLACED_ID)
    expect(onPlaceAndConnect).not.toHaveBeenCalled()
  })

  it('(d) the create affordance calls onCreateAndConnect(query)', async () => {
    renderPicker()
    await waitForNotes()
    const input = screen.getByRole('combobox')
    // A query that matches nothing → only the create row remains.
    fireEvent.change(input, { target: { value: 'brand new note' } })
    await waitFor(() =>
      expect(screen.getByText('brand new note', { exact: false })).toBeInTheDocument(),
    )

    // Click the create row directly (cmdk onSelect) to avoid depending on which
    // row Enter highlights when no note matches.
    fireEvent.click(screen.getByText('brand new note', { exact: false }))
    expect(onCreateAndConnect).toHaveBeenCalledWith('brand new note')
  })

  it('does not show a create row when the query is empty', async () => {
    renderPicker()
    await waitForNotes()
    expect(screen.queryByText('Create', { exact: false })).not.toBeInTheDocument()
  })

  it('(e) Escape calls onClose and stops propagation', () => {
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
})
