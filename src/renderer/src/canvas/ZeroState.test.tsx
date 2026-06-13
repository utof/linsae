/**
 * Component tests for ZeroState: visible vs. not-visible rendering.
 * @see src/renderer/src/canvas/ZeroState.tsx
 * @see docs/specs/v0.4-canvas-mvp.md §14
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '../../../../tests/setup'
import { ZeroState } from './ZeroState'

describe('ZeroState', () => {
  it('renders all four verbatim copy lines when visible', () => {
    renderWithProviders(<ZeroState visible={true} />)
    expect(screen.getByText('nothing here yet.')).toBeInTheDocument()
    expect(screen.getByText('this canvas only shows what you place on it.')).toBeInTheDocument()
    expect(screen.getByText('double-click to write something here,')).toBeInTheDocument()
    expect(screen.getByText('or press / to bring a note over from the feed')).toBeInTheDocument()
  })

  it('renders nothing when not visible', () => {
    const { container } = renderWithProviders(<ZeroState visible={false} />)
    expect(container.firstChild).toBeNull()
  })
})
