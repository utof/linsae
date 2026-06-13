/**
 * Component tests for the shelf pane (spec §4): the "to place (N)" / "recently
 * placed" split, row content (type glyph + title + ▦ chip), and the §4-table
 * click behaviors driven by the `view` from ShelfContext.
 *
 * @see src/renderer/src/panes/ShelfPane.tsx
 * @see docs/specs/v0.4-canvas-mvp.md §4
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, type MockApi } from '../../../../tests/setup'
import type { CanvasLayoutRow } from '../../../shared/canvas'
import type { Note } from '../../../shared/types'
import { ShelfContext, type ShelfContextValue, ShelfPaneBody, useShelf } from './ShelfPane'

let mockApi: MockApi

beforeEach(() => {
  mockApi = installMockApi()
})

function makeNote(id: string, body: string, overrides: Partial<Note> = {}): Note {
  return {
    id,
    slug: id,
    body,
    type: 'claim',
    created_at: 1000,
    updated_at: 1000,
    deleted_at: null,
    ...overrides,
  }
}

function makeRow(noteId: string, overrides: Partial<CanvasLayoutRow> = {}): CanvasLayoutRow {
  return {
    canvas_id: 'root',
    arrangement_id: 'manual',
    note_id: noteId,
    x: null,
    y: null,
    created_at: 1000,
    placed_at: null,
    updated_at: 1000,
    ...overrides,
  }
}

function makeContext(overrides: Partial<ShelfContextValue> = {}): ShelfContextValue {
  return {
    view: 'feed',
    onGotoNote: vi.fn(),
    onJumpToCard: vi.fn(),
    onBeginShelfDrag: vi.fn(),
    ...overrides,
  }
}

/**
 * Render ShelfPaneBody inside its own QueryClient, seeding both the
 * `['canvas-layouts', 'root']` query (the SAME key CanvasStage uses) and the
 * `['notes']` list cache that the rows' `['note', id]` placeholderData reads.
 */
function renderShelf(
  ctx: ShelfContextValue,
  opts: { layouts?: CanvasLayoutRow[]; notes?: Note[] } = {},
): { qc: QueryClient } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // `listLayouts` backs the ['canvas-layouts','root'] query (the SAME key
  // CanvasStage uses); mock it so the query resolves to the test rows. Seed
  // ['notes'] so each row's ['note', id] placeholderData paints immediately.
  mockApi.canvas.listLayouts.mockResolvedValue(opts.layouts ?? [])
  if (opts.notes) qc.setQueryData<Note[]>(['notes'], opts.notes)
  // Resolve api.notes.get per-id (the facade wraps it as get({ id })). A single
  // mockResolvedValue would make every row's fetch return the LAST note.
  const byId = new Map((opts.notes ?? []).map((n) => [n.id, n]))
  mockApi.notes.get.mockImplementation(async ({ id }: { id: string }) => byId.get(id) ?? null)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ShelfContext.Provider value={ctx}>{children}</ShelfContext.Provider>
    </QueryClientProvider>
  )
  render(<ShelfPaneBody />, { wrapper })
  return { qc }
}

describe('ShelfPane', () => {
  const unplacedA = makeNote('u-a', 'Alpha unplaced', { created_at: 100 })
  const unplacedB = makeNote('u-b', 'Beta unplaced', { created_at: 200 })
  const placedC = makeNote('p-c', 'Gamma placed')

  const layouts: CanvasLayoutRow[] = [
    makeRow('u-a', { created_at: 100 }),
    makeRow('u-b', { created_at: 200 }),
    makeRow('p-c', { x: 10, y: 20, placed_at: 500 }),
  ]
  const notes = [unplacedA, unplacedB, placedC]

  it('splits into "to place (N)" + "recently placed" groups with titles', async () => {
    renderShelf(makeContext(), { layouts, notes })
    expect(await screen.findByText(/to place \(2\)/i)).toBeInTheDocument()
    expect(screen.getByText(/recently placed/i)).toBeInTheDocument()
    expect(await screen.findByText('Alpha unplaced')).toBeInTheDocument()
    expect(screen.getByText('Beta unplaced')).toBeInTheDocument()
    expect(screen.getByText('Gamma placed')).toBeInTheDocument()
  })

  it('orders "to place" newest-first by created_at desc', async () => {
    renderShelf(makeContext(), { layouts, notes })
    const rows = await screen.findAllByTestId('shelf-row-unplaced')
    // Beta (created_at 200) is newer than Alpha (100) → Beta first.
    expect(rows[0]).toHaveTextContent('Beta unplaced')
    expect(rows[1]).toHaveTextContent('Alpha unplaced')
  })

  it('renders a ▦ chip on placed rows only', async () => {
    renderShelf(makeContext(), { layouts, notes })
    await screen.findByText('Gamma placed')
    const placedRow = screen.getByTestId('shelf-row-placed')
    expect(placedRow).toHaveTextContent('▦')
    const unplacedRows = screen.getAllByTestId('shelf-row-unplaced')
    for (const r of unplacedRows) expect(r).not.toHaveTextContent('▦')
  })

  it('feed view: clicking an unplaced row calls onGotoNote', async () => {
    const onGotoNote = vi.fn()
    renderShelf(makeContext({ view: 'feed', onGotoNote }), { layouts, notes })
    fireEvent.click(await screen.findByText('Alpha unplaced'))
    expect(onGotoNote).toHaveBeenCalledWith('u-a')
  })

  it('clicking a placed row calls onJumpToCard', async () => {
    const onJumpToCard = vi.fn()
    renderShelf(makeContext({ view: 'feed', onJumpToCard }), { layouts, notes })
    fireEvent.click(await screen.findByText('Gamma placed'))
    expect(onJumpToCard).toHaveBeenCalledWith('p-c')
  })

  it('canvas view: clicking an unplaced row still calls onGotoNote (switch to feed)', async () => {
    const onGotoNote = vi.fn()
    renderShelf(makeContext({ view: 'canvas', onGotoNote }), { layouts, notes })
    fireEvent.click(await screen.findByText('Alpha unplaced'))
    expect(onGotoNote).toHaveBeenCalledWith('u-a')
  })

  it('canvas view: the unplaced drag handle emits onBeginShelfDrag', async () => {
    const onBeginShelfDrag = vi.fn()
    renderShelf(makeContext({ view: 'canvas', onBeginShelfDrag }), { layouts, notes })
    await screen.findByText('Alpha unplaced')
    fireEvent.pointerDown(screen.getByRole('button', { name: /drag .*alpha.* to the canvas/i }))
    expect(onBeginShelfDrag).toHaveBeenCalledWith('u-a')
  })

  it('feed view: no drag handle (no drop target on the feed)', async () => {
    renderShelf(makeContext({ view: 'feed' }), { layouts, notes })
    await screen.findByText('Alpha unplaced')
    expect(screen.queryByRole('button', { name: /drag .* to the canvas/i })).toBeNull()
  })

  it('shows an empty hint when nothing is queued or placed', async () => {
    renderShelf(makeContext(), { layouts: [], notes: [] })
    await waitFor(() => expect(screen.getByText(/nothing on the shelf/i)).toBeInTheDocument())
  })

  it('useShelf reads the provided context value', () => {
    const ctx = makeContext({ view: 'canvas' })
    let read: ShelfContextValue | null = null
    function Probe() {
      read = useShelf()
      return null
    }
    render(
      <ShelfContext.Provider value={ctx}>
        <Probe />
      </ShelfContext.Provider>,
    )
    expect(read).toBe(ctx)
  })
})
