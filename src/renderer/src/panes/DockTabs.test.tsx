// src/renderer/src/panes/DockTabs.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DockTabs } from './DockTabs'

describe('DockTabs', () => {
  it('renders a tab per pane with the registry title', () => {
    render(
      <DockTabs
        paneIds={['pdf', 'backlinks']}
        activeId="pdf"
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole('tab', { name: /pdf/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /backlinks/i })).toBeInTheDocument()
  })
  it('clicking a tab activates it', () => {
    const onActivate = vi.fn()
    render(
      <DockTabs
        paneIds={['pdf', 'backlinks']}
        activeId="pdf"
        onActivate={onActivate}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: /backlinks/i }))
    expect(onActivate).toHaveBeenCalledWith('backlinks')
  })
  it('the per-tab × closes without activating', () => {
    const onClose = vi.fn()
    const onActivate = vi.fn()
    render(
      <DockTabs
        paneIds={['pdf', 'backlinks']}
        activeId="pdf"
        onActivate={onActivate}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /close backlinks/i }))
    expect(onClose).toHaveBeenCalledWith('backlinks')
    expect(onActivate).not.toHaveBeenCalled()
  })
  it('ArrowRight on the tablist activates the next pane', () => {
    const onActivate = vi.fn()
    render(
      <DockTabs
        paneIds={['pdf', 'backlinks']}
        activeId="pdf"
        onActivate={onActivate}
        onClose={vi.fn()}
      />,
    )
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(onActivate).toHaveBeenCalledWith('backlinks')
  })
  it('ArrowLeft on the tablist activates the previous pane', () => {
    const onActivate = vi.fn()
    render(
      <DockTabs
        paneIds={['pdf', 'backlinks']}
        activeId="backlinks"
        onActivate={onActivate}
        onClose={vi.fn()}
      />,
    )
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' })
    expect(onActivate).toHaveBeenCalledWith('pdf')
  })
  it('ArrowRight on the last tab is a no-op (boundary guard)', () => {
    const onActivate = vi.fn()
    render(
      <DockTabs
        paneIds={['pdf', 'backlinks']}
        activeId="backlinks"
        onActivate={onActivate}
        onClose={vi.fn()}
      />,
    )
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(onActivate).not.toHaveBeenCalled()
  })
})
