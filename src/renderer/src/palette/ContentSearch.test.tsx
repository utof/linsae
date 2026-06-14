/**
 * ContentSearch (⌘P) component tests.
 *
 * installMockApi's override merge is shallow at the namespace level (tests/setup.tsx:215
 * `...overrides`), so `{ notes: { recent } }` REPLACES the whole `notes` mock and
 * `{ search, notes }` replaces both. ContentSearch calls `api.search.run`,
 * `api.notes.recent`, and `useSetting('notes.recencyMode','frecent')`→`api.settings.get`.
 * The `settings` namespace is NOT touched by these overrides, so its default mock
 * (`{ value: null }`) survives → useSetting returns the 'frecent' default and the
 * component never crashes.
 *
 * @see docs/plans/v0.5-command-search.md Task 11
 * @see src/renderer/src/palette/ContentSearch.tsx
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { installMockApi, renderWithProviders } from '../../../../tests/setup'
import { ContentSearch } from './ContentSearch'

describe('ContentSearch (⌘P)', () => {
  it('empty query → recent/frecent rows (not the FTS hint)', async () => {
    installMockApi({
      notes: { recent: vi.fn(async () => [{ id: '9', title: 'Recent note' }]) } as never,
    })
    renderWithProviders(<ContentSearch open onJump={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByText('Recent note')).toBeInTheDocument()
  })
  it('typing runs FTS; rows show title + snippet; Enter jumps', async () => {
    const run = vi.fn(async () => [
      {
        note: {
          id: '1',
          slug: 'a',
          body: 'x',
          type: 'claim',
          created_at: 0,
          updated_at: 0,
          deleted_at: null,
        },
        title: 'Annotation',
        snippet: 'has <mark>annot</mark>',
        rank: -1,
      },
    ])
    const onJump = vi.fn()
    installMockApi({ search: { run } as never, notes: { recent: vi.fn(async () => []) } as never })
    renderWithProviders(<ContentSearch open onJump={onJump} onClose={vi.fn()} />)
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'annot' } })
    expect(await screen.findByText('Annotation')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    await waitFor(() => expect(onJump).toHaveBeenCalledWith('1'))
  })
})
