import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dock } from './Dock'
import * as PaneModule from './Pane'

// Trivial body per pane id → no ShelfPaneBody/PdfReader query mounts.
beforeEach(() => {
  vi.spyOn(PaneModule, 'getPane').mockImplementation((id: string) => ({
    id,
    title: id,
    homeDock: id === 'shelf' ? 'left' : 'right',
    kind: id === 'pdf' ? 'content' : 'utility',
    render: () => <div>{id} body</div>,
  }))
})
afterEach(() => vi.restoreAllMocks())

const base = {
  side: 'left' as const,
  width: 280,
  onActivate: vi.fn(),
  onClose: vi.fn(),
  onWidthChange: vi.fn(),
}

describe('Dock', () => {
  it('one pane → quiet header (close button), no tablist', () => {
    render(<Dock {...base} openPaneIds={['shelf']} activeId="shelf" />)
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('button', { name: /close shelf/i })).toBeInTheDocument()
  })
  it('two panes → tablist', () => {
    render(<Dock {...base} side="right" openPaneIds={['pdf', 'backlinks']} activeId="pdf" />)
    expect(screen.getByRole('tablist')).toBeInTheDocument()
  })
  it('renders the active pane body', () => {
    render(<Dock {...base} openPaneIds={['shelf']} activeId="shelf" />)
    expect(screen.getByText('shelf body')).toBeInTheDocument()
  })
})
