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
  it('FTS-empty query falls back to fuzzy title match (⌘O-style), Enter jumps', async () => {
    // "cu" is not a word FTS can prefix-match in any body, but it IS a
    // subsequence of the title "claude" (c…u) — the ⌘O fuzzy path. When ⌘P's
    // FTS returns nothing, it should fall back to that fuzzy title feed so
    // the result list is never empty when a title could match.
    const run = vi.fn(async () => [])
    const listTitles = vi.fn(async () => [{ id: '2', title: 'claude' }])
    const onJump = vi.fn()
    installMockApi({
      search: { run } as never,
      notes: { recent: vi.fn(async () => []), listTitles } as never,
    })
    renderWithProviders(<ContentSearch open onJump={onJump} onClose={vi.fn()} />)
    const input = await screen.findByRole('combobox')
    fireEvent.change(input, { target: { value: 'cu' } })
    // FTS returned nothing → fuzzy-title fallback fires; the title "claude"
    // (c…u subsequence) renders as a cmdk option with matched chars in <mark>.
    const rows = await screen.findAllByRole('option')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toBe('claude')
    expect(rows[0]?.querySelector('mark')).toBeTruthy()
    // The "no matches." empty-state must NOT appear while the fallback has rows.
    expect(screen.queryByText('no matches.')).not.toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onJump).toHaveBeenCalledWith('2'))
  })
  it('FTS-empty AND fuzzy-empty → "no matches." still shows', async () => {
    const run = vi.fn(async () => [])
    const listTitles = vi.fn(async () => [{ id: '2', title: 'claude' }])
    installMockApi({
      search: { run } as never,
      notes: { recent: vi.fn(async () => []), listTitles } as never,
    })
    renderWithProviders(<ContentSearch open onJump={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'zzz' } })
    expect(await screen.findByText('no matches.')).toBeInTheDocument()
  })
  it('Tab moves selection down through FTS results (item 9)', async () => {
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
        title: 'Apple',
        snippet: 'has <mark>ap</mark>',
        rank: -1,
      },
      {
        note: {
          id: '2',
          slug: 'b',
          body: 'y',
          type: 'claim',
          created_at: 0,
          updated_at: 0,
          deleted_at: null,
        },
        title: 'Apricot',
        snippet: 'has <mark>ap</mark>',
        rank: -2,
      },
    ])
    installMockApi({ search: { run } as never, notes: { recent: vi.fn(async () => []) } as never })
    renderWithProviders(<ContentSearch open onJump={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'ap' } })
    const rows = await screen.findAllByRole('option')
    expect(rows).toHaveLength(2)
    function selectedId(): string | null {
      const sel = rows.find((r) => r.getAttribute('aria-selected') === 'true')
      return sel?.getAttribute('data-value') ?? null
    }
    await waitFor(() => expect(selectedId()).toBe('1'))
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Tab' })
    await waitFor(() => expect(selectedId()).toBe('2'))
  })
})
