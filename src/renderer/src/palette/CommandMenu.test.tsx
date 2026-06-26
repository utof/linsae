import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, renderWithProviders } from '../../../../tests/setup'
import { CommandMenu } from './CommandMenu'
import { useCommandStore } from './command-store'

afterEach(() => useCommandStore.getState().reset())

describe('CommandMenu', () => {
  it('renders registered commands with their hints; Enter runs + closes', async () => {
    installMockApi()
    const run = vi.fn()
    const onClose = vi.fn()
    useCommandStore.getState().register({ id: 'new', label: 'New note', hint: '⌘N', run })
    renderWithProviders(<CommandMenu open onClose={onClose} />)
    expect(await screen.findByText('New note')).toBeInTheDocument()
    expect(screen.getByText('⌘N')).toBeInTheDocument()
    fireEvent.keyDown(await screen.findByRole('combobox'), { key: 'Enter' })
    expect(run).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('fuzzy-filters labels (typing narrows)', async () => {
    installMockApi()
    // fuzzy.ts is a SUBSEQUENCE matcher (fuzzy.ts:1) — the plan's original 'Search
    // by title' label is a false negative here: 'sett' subsequence-matches it
    // (S-…-e-…-ti-t-l-e), so it would NOT be filtered out. 'New note' has no
    // 's-e-t-t' subsequence, so it's correctly excluded — preserving the test's
    // intent (typing narrows the visible commands).
    useCommandStore.getState().register({ id: 'a', label: 'New note', run: vi.fn() })
    useCommandStore.getState().register({ id: 'b', label: 'Open settings', run: vi.fn() })
    renderWithProviders(<CommandMenu open onClose={vi.fn()} />)
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'sett' } })
    // The matched label's chars get wrapped in <mark> (highlight helper), so
    // findByText('Open settings') would fail on the split text — query by role
    // and read textContent instead (mirrors QuickSwitcher.test.tsx).
    const rows = await screen.findAllByRole('option')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toBe('Open settings')
    expect(screen.queryByText('New note')).toBeNull()
  })

  it('hides commands whose when() is false', async () => {
    installMockApi()
    useCommandStore.getState().register({ id: 'a', label: 'Always', run: vi.fn() })
    useCommandStore
      .getState()
      .register({ id: 'b', label: 'Canvas only', run: vi.fn(), when: () => false })
    renderWithProviders(<CommandMenu open onClose={vi.fn()} />)
    expect(await screen.findByText('Always')).toBeInTheDocument()
    expect(screen.queryByText('Canvas only')).toBeNull()
  })

  it('Tab moves selection down through commands (item 9)', async () => {
    installMockApi()
    useCommandStore.getState().register({ id: 'a', label: 'Alpha cmd', run: vi.fn() })
    useCommandStore.getState().register({ id: 'b', label: 'Beta cmd', run: vi.fn() })
    renderWithProviders(<CommandMenu open onClose={vi.fn()} />)
    const rows = await screen.findAllByRole('option')
    expect(rows).toHaveLength(2)
    function selectedId(): string | null {
      const sel = rows.find((r) => r.getAttribute('aria-selected') === 'true')
      return sel?.getAttribute('data-value') ?? null
    }
    await waitFor(() => expect(selectedId()).toBe('a'))
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Tab' })
    await waitFor(() => expect(selectedId()).toBe('b'))
  })
})
