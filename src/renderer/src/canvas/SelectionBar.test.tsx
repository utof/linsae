import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '../../../../tests/setup'
import { CanvasSelectionBar } from './SelectionBar'

describe('CanvasSelectionBar', () => {
  it('renders the count and the two verbs', () => {
    renderWithProviders(
      <CanvasSelectionBar count={3} onRemove={vi.fn()} onDeleteRequest={vi.fn()} />,
    )
    expect(screen.getByText(/3 selected/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /remove from canvas/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete note/i })).toBeInTheDocument()
  })
  it('renders nothing at zero', () => {
    const { container } = renderWithProviders(
      <CanvasSelectionBar count={0} onRemove={vi.fn()} onDeleteRequest={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })
  it('fires the verb callbacks', () => {
    const onRemove = vi.fn()
    const onDeleteRequest = vi.fn()
    renderWithProviders(
      <CanvasSelectionBar count={1} onRemove={onRemove} onDeleteRequest={onDeleteRequest} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /remove from canvas/i }))
    fireEvent.click(screen.getByRole('button', { name: /delete note/i }))
    expect(onRemove).toHaveBeenCalledOnce()
    expect(onDeleteRequest).toHaveBeenCalledOnce()
  })
})
