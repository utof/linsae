import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, type MockApi, renderWithProviders } from '../../../../tests/setup'
import { BacklinksPane } from './BacklinksPane'

let mockApi: MockApi
beforeEach(() => {
  mockApi = installMockApi()
})

describe('BacklinksPane', () => {
  it('renders nothing when focusedNoteId is null', () => {
    const { container } = renderWithProviders(
      <BacklinksPane focusedNoteId={null} onClose={() => {}} onJump={() => {}} />,
    )
    expect(container.querySelector('aside')).toBeNull()
  })

  it('shows empty-state copy when no incoming links', async () => {
    mockApi.links.backlinks.mockResolvedValueOnce([])
    renderWithProviders(<BacklinksPane focusedNoteId="n1" onClose={() => {}} onJump={() => {}} />)
    await waitFor(() => expect(screen.getByText(/nothing links here yet/i)).toBeInTheDocument())
  })

  it('renders rows for each backlink with note body preview', async () => {
    mockApi.links.backlinks.mockResolvedValueOnce([
      {
        id: 'src1',
        slug: 'src 1',
        body: 'first line of source 1',
        type: 'claim',
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: 'src2',
        slug: 'src 2',
        body: 'first line of source 2',
        type: 'claim',
        created_at: 2,
        updated_at: 2,
        deleted_at: null,
      },
    ])
    renderWithProviders(<BacklinksPane focusedNoteId="tgt" onClose={() => {}} onJump={() => {}} />)
    await waitFor(() => expect(screen.getByText(/first line of source 1/i)).toBeInTheDocument())
    expect(screen.getByText(/first line of source 2/i)).toBeInTheDocument()
  })

  it('clicking the close button calls onClose', async () => {
    mockApi.links.backlinks.mockResolvedValueOnce([])
    const onClose = vi.fn()
    renderWithProviders(<BacklinksPane focusedNoteId="n1" onClose={onClose} onJump={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText(/close pane/i)).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText(/close pane/i))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('clicking a row calls onJump with the note id', async () => {
    mockApi.links.backlinks.mockResolvedValueOnce([
      {
        id: 'src1',
        slug: 'a',
        body: 'preview text',
        type: 'claim',
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
    ])
    const onJump = vi.fn()
    renderWithProviders(<BacklinksPane focusedNoteId="tgt" onClose={() => {}} onJump={onJump} />)
    await waitFor(() => expect(screen.getByText(/preview text/i)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/preview text/i))
    expect(onJump).toHaveBeenCalledExactlyOnceWith('src1')
  })
})
