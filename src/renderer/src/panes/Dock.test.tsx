import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '../../../../tests/setup'
import { Dock } from './Dock'

describe('Dock', () => {
  it('renders the pane title + close button when open', () => {
    renderWithProviders(<Dock open paneId="shelf" onClose={vi.fn()} />)
    expect(screen.getByText('shelf')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /close shelf/i })).toBeInTheDocument()
  })
  it('renders nothing when closed', () => {
    const { container } = renderWithProviders(
      <Dock open={false} paneId="shelf" onClose={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })
  it('calls onClose when × is clicked', () => {
    const onClose = vi.fn()
    renderWithProviders(<Dock open paneId="shelf" onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close shelf/i }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
