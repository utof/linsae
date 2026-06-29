import { fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderWithProviders } from '../../../../tests/setup'
import { PlacementGhost } from './PlacementGhost'

/**
 * B16 — window-level placement ghost. While a one-shot placement is active App
 * mounts <PlacementGhost>; it must follow the cursor across the WHOLE window
 * (portaled to document.body, above the dock) and show a "release over the
 * canvas" affordance when the cursor is NOT over the canvas drop surface.
 *
 * @see src/renderer/src/canvas/PlacementGhost.tsx
 */
describe('PlacementGhost', () => {
  afterEach(() => {
    // The component portals to document.body; clear any stray canvas-viewport
    // fixtures appended by a test (renderWithProviders cleans its own container).
    for (const el of document.querySelectorAll('[data-canvas-viewport]')) el.remove()
  })

  it('renders nothing until the first pointer move (no cursor position yet)', () => {
    renderWithProviders(<PlacementGhost title="my note" />)
    expect(document.querySelector('[data-placement-ghost]')).toBeNull()
  })

  it('after a pointer move OFF the canvas: shows the card at the cursor + the drop hint', () => {
    renderWithProviders(<PlacementGhost title="my note" />)
    // A non-canvas target (plain body) → not over the drop surface.
    fireEvent.pointerMove(document.body, { clientX: 120, clientY: 80 })

    const ghost = document.querySelector('[data-placement-ghost]') as HTMLElement
    expect(ghost).not.toBeNull()
    expect(ghost.textContent).toContain('my note')
    // Positioned at the cursor (top-left anchor = drop point).
    expect(ghost.style.left).toBe('120px')
    expect(ghost.style.top).toBe('80px')
    // Off-canvas affordance.
    expect(ghost.getAttribute('data-over-canvas')).toBe('false')
    expect(screen.getByText(/release over the canvas to drop/i)).toBeInTheDocument()
  })

  it('after a pointer move OVER the canvas viewport: no drop hint, data-over-canvas=true', () => {
    // A stand-in for CanvasStage's `[data-canvas-viewport]` drop surface.
    const viewport = document.createElement('div')
    viewport.setAttribute('data-canvas-viewport', '')
    document.body.appendChild(viewport)

    renderWithProviders(<PlacementGhost title="my note" />)
    fireEvent.pointerMove(viewport, { clientX: 300, clientY: 200 })

    const ghost = document.querySelector('[data-placement-ghost]') as HTMLElement
    expect(ghost).not.toBeNull()
    expect(ghost.getAttribute('data-over-canvas')).toBe('true')
    expect(screen.queryByText(/release over the canvas to drop/i)).not.toBeInTheDocument()
  })
})
