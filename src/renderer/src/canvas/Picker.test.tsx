/**
 * Component tests for the canvas `/` Picker: fuzzy-ranked rows over live notes
 * (`notes:list`, not FTS — spec decision 5 / §4), matched-char highlight,
 * keymap (`↵` / `⇧↵` / `esc`), ▦ jump-not-duplicate, and footer hint text.
 *
 * Mirrors EdgeTargetPicker.test.tsx's RTL approach for cmdk-in-happy-dom
 * (controlled `value`, `fireEvent.change` to type, `fireEvent.keyDown` for
 * Enter/Esc), since both pickers share the notes:list + fuzzy + highlight pipe.
 *
 * @see src/renderer/src/canvas/Picker.tsx
 * @see docs/specs/v0.4.1-canvas-edges.md §4
 * @see docs/plans/v0.4.1-canvas-edges.md Task 8 Step 1
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, type MockApi, renderWithProviders } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'
import { Picker } from './Picker'

let mockApi: MockApi
const onPick = vi.fn()
const onJump = vi.fn()
const onClose = vi.fn()

const PLACED_ID = 'placed-note-1'
const UNPLACED_ID = 'unplaced-note-2'
const placedNoteIds = new Set([PLACED_ID])

function note(id: string, body: string, type: Note['type'] = 'claim'): Note {
  return {
    id,
    slug: id,
    body,
    type,
    created_at: 1000,
    updated_at: 1000,
    deleted_at: null,
  }
}

// `claude` is the fuzzy target for `cu` (subsequence); `Placed thing` is the
// already-placed row; `Random other` is filtered out by a `cu` query.
const notes: Note[] = [
  note(UNPLACED_ID, 'claude shannon'),
  note(PLACED_ID, 'Placed thing', 'question'),
  note('other-3', 'Random other'),
]

beforeEach(() => {
  mockApi = installMockApi()
  mockApi.notes.list.mockResolvedValue(notes)
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

/** Wait for the note list to resolve into the query cache (rows render on data). */
async function waitForNotes() {
  await waitFor(() => expect(mockApi.notes.list).toHaveBeenCalled())
}

describe('Picker', () => {
  it('renders the search input', () => {
    renderPicker()
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('typing fuzzy-ranks + filters live notes (cu surfaces claude) and highlights matched chars', async () => {
    renderPicker()
    await waitForNotes()
    const input = screen.getByRole('combobox')
    // `cu` is a subsequence of `claude shannon` but not `Placed thing`/`Random other`.
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

  it('renders the type glyph for a row (preserved from the FTS version)', async () => {
    renderPicker()
    await waitForNotes()
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'cu' } })
    await waitFor(() => expect(screen.getByText('shannon', { exact: false })).toBeInTheDocument())
    // `claude shannon` is a 'claim' → ● glyph (from NOTE_TYPE_GLYPH).
    expect(screen.getByText('●')).toBeInTheDocument()
  })

  it('shows the empty-query hint instead of all rows (no 500-row dump)', async () => {
    renderPicker()
    await waitForNotes()
    // Empty query: fuzzyMatch('') would return every note, but the picker gates
    // rows on query.length>0 and shows the hint instead.
    expect(screen.getByText('type to search…')).toBeInTheDocument()
    expect(screen.queryByText('claude shannon')).not.toBeInTheDocument()
    expect(screen.queryByText('Placed thing')).not.toBeInTheDocument()
  })

  it('hides stale rows when the query is cleared to empty', async () => {
    // Gating the row map on query.length>0 must hide the rows so the
    // "type to search" empty state stands alone (and ⇧↵'s clear-query path,
    // which keeps the picker open, is clean).
    renderPicker()
    await waitForNotes()
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'cu' } })
    await waitFor(() => expect(screen.getByText('shannon', { exact: false })).toBeInTheDocument())
    // Backspace the query to empty
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(screen.getByText('type to search…')).toBeInTheDocument())
    expect(screen.queryByText('shannon', { exact: false })).not.toBeInTheDocument()
  })

  it('shows a ▦ chip on the placed row', async () => {
    renderPicker()
    await waitForNotes()
    // `placed` matches only the placed row.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'placed' } })
    await waitFor(() => expect(screen.getByText('thing', { exact: false })).toBeInTheDocument())
    const chips = screen.getAllByText('▦')
    expect(chips.length).toBeGreaterThanOrEqual(1)
  })

  it('Enter on unplaced row calls onPick(id, {keepOpen:false})', async () => {
    renderPicker()
    await waitForNotes()
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'cu' } })
    await waitFor(() => expect(screen.getByText('shannon', { exact: false })).toBeInTheDocument())

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })
    expect(onPick).toHaveBeenCalledWith(UNPLACED_ID, { keepOpen: false })
    expect(onJump).not.toHaveBeenCalled()
  })

  it('Shift+Enter on unplaced row calls onPick(id, {keepOpen:true})', async () => {
    renderPicker()
    await waitForNotes()
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'cu' } })
    await waitFor(() => expect(screen.getByText('shannon', { exact: false })).toBeInTheDocument())

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onPick).toHaveBeenCalledWith(UNPLACED_ID, { keepOpen: true })
    expect(onJump).not.toHaveBeenCalled()
  })

  it('Shift+Enter clears the query but keeps the picker open (seed-a-board, §5)', async () => {
    // ⇧↵ seeds a board with DIFFERENT notes: after the pick the query input must
    // reset to empty (so the next pick isn't the same highlighted row) while the
    // picker stays mounted. onClose must NOT fire.
    renderPicker()
    await waitForNotes()
    const input = screen.getByRole('combobox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'cu' } })
    await waitFor(() => expect(screen.getByText('shannon', { exact: false })).toBeInTheDocument())

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onPick).toHaveBeenCalledWith(UNPLACED_ID, { keepOpen: true })
    // Query cleared → input empties and the rows reset to the empty state.
    await waitFor(() => expect(screen.getByText('type to search…')).toBeInTheDocument())
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Enter on placed row calls onJump(id) — jump-not-duplicate (§5)', async () => {
    renderPicker()
    await waitForNotes()
    const input = screen.getByRole('combobox')
    // `placed` matches only the placed row → it's first + auto-highlighted.
    fireEvent.change(input, { target: { value: 'placed' } })
    await waitFor(() => expect(screen.getByText('thing', { exact: false })).toBeInTheDocument())

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
