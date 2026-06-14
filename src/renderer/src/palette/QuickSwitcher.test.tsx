/**
 * QuickSwitcher (⌘O) component tests.
 *
 * installMockApi's override merge is shallow at the namespace level (tests/setup.tsx:215
 * `...overrides`), so passing `{ notes: { listTitles, recent } }` REPLACES the whole
 * `notes` mock. QuickSwitcher only calls `notes.listTitles` + `notes.recent`, so that
 * narrow override is honest. `useSetting('notes.recencyMode', 'frecent')` hits
 * `api.settings.get`, but the `settings` namespace is NOT touched by a `notes`-only
 * override, so its default mock (`{ value: null }`) survives → useSetting returns the
 * 'frecent' default and the component never crashes.
 *
 * @see docs/plans/v0.5-command-search.md Task 7
 * @see src/renderer/src/palette/QuickSwitcher.tsx
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { installMockApi, renderWithProviders } from '../../../../tests/setup'
import { QuickSwitcher } from './QuickSwitcher'

const titles = [
  { id: '1', title: 'Claude notes' },
  { id: '2', title: 'Banana bread' },
]

describe('QuickSwitcher', () => {
  it('empty query shows recent/frecent (not all titles)', async () => {
    const onJump = vi.fn()
    const onClose = vi.fn()
    const recent = vi.fn(async () => [{ id: '9', title: 'Recent one' }])
    const listTitles = vi.fn(async () => titles)
    installMockApi({ notes: { listTitles, recent } as never })
    renderWithProviders(<QuickSwitcher open onJump={onJump} onClose={onClose} />)

    await waitFor(() => expect(recent).toHaveBeenCalled())
    expect(await screen.findByText('Recent one')).toBeInTheDocument()
    // The full title list is NOT shown for an empty query — only recents.
    expect(screen.queryByText('Banana bread')).toBeNull()
    expect(screen.queryByText('Claude notes')).toBeNull()
  })

  it('typing fuzzy-filters + highlights matched chars; Enter jumps', async () => {
    const onJump = vi.fn()
    const onClose = vi.fn()
    const listTitles = vi.fn(async () => titles)
    const recent = vi.fn(async () => [])
    installMockApi({ notes: { listTitles, recent } as never })
    renderWithProviders(<QuickSwitcher open onJump={onJump} onClose={onClose} />)

    // listTitles must resolve before fuzzyMatch has candidates to filter.
    await waitFor(() => expect(listTitles).toHaveBeenCalled())
    const input = await screen.findByRole('combobox')
    fireEvent.change(input, { target: { value: 'cl' } })

    // Only the matching row renders (cmdk Item → role="option"); the non-match
    // is filtered out by fuzzyMatch.
    const rows = await screen.findAllByRole('option')
    expect(rows).toHaveLength(1)
    const [first] = rows
    expect(first).toBeDefined()
    expect(first?.textContent).toBe('Claude notes')
    // The matched "cl" prefix is wrapped in <mark> for highlighting.
    const mark = first?.querySelector('mark')
    expect(mark).toBeTruthy()
    expect(mark?.textContent).toBe('Cl')
    expect(screen.queryByText('Banana bread')).toBeNull()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onJump).toHaveBeenCalledWith('1')
    expect(onClose).toHaveBeenCalled()
  })

  it('whitespace-only query still shows recent (trim gate), never all titles', async () => {
    const listTitles = vi.fn(async () => titles)
    const recent = vi.fn(async () => [{ id: '9', title: 'Recent one' }])
    installMockApi({ notes: { listTitles, recent } as never })
    renderWithProviders(<QuickSwitcher open onJump={vi.fn()} onClose={vi.fn()} />)

    const input = await screen.findByRole('combobox')
    fireEvent.change(input, { target: { value: '   ' } })

    expect(await screen.findByText('Recent one')).toBeInTheDocument()
    expect(screen.queryByText('Banana bread')).toBeNull()
    expect(screen.queryByText('Claude notes')).toBeNull()
  })

  it('esc closes', async () => {
    const onClose = vi.fn()
    installMockApi({
      notes: { listTitles: vi.fn(async () => titles), recent: vi.fn(async () => []) } as never,
    })
    renderWithProviders(<QuickSwitcher open onJump={vi.fn()} onClose={onClose} />)

    const input = await screen.findByRole('combobox')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
