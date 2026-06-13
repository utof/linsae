/**
 * Component tests for StatusBar: feed vs. canvas view, zoom pill, callbacks.
 * @see src/renderer/src/canvas/StatusBar.tsx
 * @see docs/specs/v0.4-canvas-mvp.md §14
 */
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '../../../../tests/setup'
import { StatusBar } from './StatusBar'

const noop = vi.fn()

function mkProps(overrides: Partial<Parameters<typeof StatusBar>[0]> = {}) {
  return {
    view: 'canvas' as const,
    placedCount: 5,
    unplacedCount: 3,
    zoomPct: 87,
    onOpenShelf: noop,
    onResetZoom: noop,
    onFit: noop,
    onToggleRecent: noop,
    ...overrides,
  }
}

describe('StatusBar — feed view', () => {
  it('shows only the unplaced indicator when unplacedCount > 0', () => {
    renderWithProviders(<StatusBar {...mkProps({ view: 'feed', unplacedCount: 2 })} />)
    expect(screen.getByText(/2 unplaced/)).toBeInTheDocument()
    // Canvas-only elements must be absent
    expect(screen.queryByText(/notes/)).not.toBeInTheDocument()
    expect(screen.queryByText(/fit/)).not.toBeInTheDocument()
    expect(screen.queryByText(/recent/)).not.toBeInTheDocument()
  })

  it('hides the unplaced indicator at 0', () => {
    renderWithProviders(<StatusBar {...mkProps({ view: 'feed', unplacedCount: 0 })} />)
    expect(screen.queryByText(/unplaced/)).not.toBeInTheDocument()
  })

  it('clicking the unplaced indicator fires onOpenShelf', () => {
    const onOpenShelf = vi.fn()
    renderWithProviders(<StatusBar {...mkProps({ view: 'feed', unplacedCount: 4, onOpenShelf })} />)
    fireEvent.click(screen.getByText(/4 unplaced/))
    expect(onOpenShelf).toHaveBeenCalledOnce()
  })
})

describe('StatusBar — canvas view', () => {
  it('shows placedCount notes label', () => {
    renderWithProviders(<StatusBar {...mkProps({ placedCount: 7 })} />)
    expect(screen.getByText(/7 notes/)).toBeInTheDocument()
  })

  it('shows zoom pill with % readout', () => {
    renderWithProviders(<StatusBar {...mkProps({ zoomPct: 87 })} />)
    expect(screen.getByText(/87%/)).toBeInTheDocument()
  })

  it('shows "fit" button', () => {
    renderWithProviders(<StatusBar {...mkProps()} />)
    expect(screen.getByRole('button', { name: /fit/i })).toBeInTheDocument()
  })

  it('shows "1:1" when zoom !== 100', () => {
    renderWithProviders(<StatusBar {...mkProps({ zoomPct: 87 })} />)
    expect(screen.getByRole('button', { name: /1:1/i })).toBeInTheDocument()
  })

  it('hides "1:1" when zoom === 100', () => {
    renderWithProviders(<StatusBar {...mkProps({ zoomPct: 100 })} />)
    expect(screen.queryByRole('button', { name: /1:1/i })).not.toBeInTheDocument()
  })

  it('shows recent trigger', () => {
    renderWithProviders(<StatusBar {...mkProps()} />)
    expect(screen.getByRole('button', { name: /recent/i })).toBeInTheDocument()
  })

  it('shows unplaced indicator when unplacedCount > 0', () => {
    renderWithProviders(<StatusBar {...mkProps({ unplacedCount: 3 })} />)
    expect(screen.getByText(/3 unplaced/)).toBeInTheDocument()
  })

  it('hides unplaced indicator at 0', () => {
    renderWithProviders(<StatusBar {...mkProps({ unplacedCount: 0 })} />)
    expect(screen.queryByText(/unplaced/)).not.toBeInTheDocument()
  })

  it('% click fires onResetZoom', () => {
    const onResetZoom = vi.fn()
    renderWithProviders(<StatusBar {...mkProps({ onResetZoom })} />)
    fireEvent.click(screen.getByText(/87%/))
    expect(onResetZoom).toHaveBeenCalledOnce()
  })

  it('fit click fires onFit', () => {
    const onFit = vi.fn()
    renderWithProviders(<StatusBar {...mkProps({ onFit })} />)
    fireEvent.click(screen.getByRole('button', { name: /fit/i }))
    expect(onFit).toHaveBeenCalledOnce()
  })

  it('1:1 click fires onResetZoom', () => {
    const onResetZoom = vi.fn()
    renderWithProviders(<StatusBar {...mkProps({ zoomPct: 75, onResetZoom })} />)
    fireEvent.click(screen.getByRole('button', { name: /1:1/i }))
    expect(onResetZoom).toHaveBeenCalledOnce()
  })

  it('recent trigger fires onToggleRecent', () => {
    const onToggleRecent = vi.fn()
    renderWithProviders(<StatusBar {...mkProps({ onToggleRecent })} />)
    fireEvent.click(screen.getByRole('button', { name: /recent/i }))
    expect(onToggleRecent).toHaveBeenCalledOnce()
  })

  it('unplaced indicator click fires onOpenShelf', () => {
    const onOpenShelf = vi.fn()
    renderWithProviders(<StatusBar {...mkProps({ unplacedCount: 2, onOpenShelf })} />)
    fireEvent.click(screen.getByText(/2 unplaced/))
    expect(onOpenShelf).toHaveBeenCalledOnce()
  })
})
