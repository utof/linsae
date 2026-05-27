import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installMockApi, type MockApi, renderWithProviders } from '../../../../tests/setup'
import { CommandPalette } from './CommandPalette'

let mockApi: MockApi
beforeEach(() => {
  mockApi = installMockApi()
})

describe('CommandPalette', () => {
  it('shows empty-state copy when no query yet', () => {
    renderWithProviders(<CommandPalette open={true} onClose={() => {}} onJump={() => {}} />)
    expect(screen.getByText(/type to search your notes/i)).toBeInTheDocument()
  })

  it('renders FTS results when search returns hits', async () => {
    mockApi.search.run.mockResolvedValueOnce([
      {
        note: {
          id: 'n1',
          slug: 'a',
          body: 'spectral',
          type: 'claim',
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        },
        snippet: '<mark>spectral</mark> sequences',
        rank: -1,
      },
    ])
    renderWithProviders(<CommandPalette open={true} onClose={() => {}} onJump={() => {}} />)
    const input = screen.getByPlaceholderText(/type to search/i)
    fireEvent.change(input, { target: { value: 'spectral' } })
    await waitFor(() => expect(mockApi.search.run).toHaveBeenCalled())
    // Verify the snippet renders to the DOM (search→fetch→render integration,
    // not just the IPC wiring). Catches regressions where dangerouslySetInnerHTML
    // silently breaks.
    await waitFor(() => expect(screen.getByText(/sequences/i)).toBeInTheDocument())
  })

  it('shows "no matches" when query has no results', async () => {
    mockApi.search.run.mockResolvedValueOnce([])
    renderWithProviders(<CommandPalette open={true} onClose={() => {}} onJump={() => {}} />)
    const input = screen.getByPlaceholderText(/type to search/i)
    fireEvent.change(input, { target: { value: 'xyzzy' } })
    await waitFor(() => expect(screen.getByText(/no matches/i)).toBeInTheDocument())
  })

  it('renders nothing when open=false', () => {
    const { container } = renderWithProviders(
      <CommandPalette open={false} onClose={() => {}} onJump={() => {}} />,
    )
    expect(container.querySelector('[cmdk-dialog]')).toBeNull()
  })
})
