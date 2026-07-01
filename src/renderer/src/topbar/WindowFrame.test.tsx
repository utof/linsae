import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installMockApi,
  type MockApi,
  renderWithProviders as render,
} from '../../../../tests/setup'
import { WindowFrame } from './WindowFrame'

let mockApi: MockApi

beforeEach(() => {
  mockApi = installMockApi()
})

/** Required-prop defaults so each test only overrides what it asserts on. */
const baseProps = {
  onOpenPalette: () => {},
  onOpenSettings: () => {},
  view: 'feed' as const,
  onViewChange: () => {},
  dockOpen: false,
  onToggleDock: () => {},
  backlinksOpen: false,
  onToggleBacklinks: () => {},
}

describe('WindowFrame', () => {
  it('⌘K pill triggers onOpenPalette', () => {
    const onOpen = vi.fn()
    render(<WindowFrame {...baseProps} onOpenPalette={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /open command palette/i }))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('settings gear triggers onOpenSettings', () => {
    const onSettings = vi.fn()
    render(<WindowFrame {...baseProps} onOpenSettings={onSettings} />)
    fireEvent.click(screen.getByRole('button', { name: /settings/i }))
    expect(onSettings).toHaveBeenCalledOnce()
  })

  it('reveal-notes button calls api.system.revealNotesFolder', () => {
    render(<WindowFrame {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: /reveal notes folder/i }))
    expect(mockApi.system.revealNotesFolder).toHaveBeenCalledOnce()
  })

  it('minimize button calls api.system.window.minimize', () => {
    render(<WindowFrame {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: /minimize/i }))
    expect(mockApi.system.window.minimize).toHaveBeenCalledOnce()
  })

  it('maximize button calls api.system.window.toggleMaximize', () => {
    render(<WindowFrame {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: /maximize/i }))
    expect(mockApi.system.window.toggleMaximize).toHaveBeenCalledOnce()
  })

  it('close button calls api.system.window.close', () => {
    render(<WindowFrame {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }))
    expect(mockApi.system.window.close).toHaveBeenCalledOnce()
  })

  it('dock toggle renders, reflects dockOpen, and fires onToggleDock', () => {
    const onToggleDock = vi.fn()
    render(<WindowFrame {...baseProps} dockOpen={false} onToggleDock={onToggleDock} />)
    const toggle = screen.getByRole('button', { name: /toggle shelf/i })
    // aria-pressed mirrors dockOpen so the quiet state is assertable.
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(onToggleDock).toHaveBeenCalledOnce()
  })

  it('dock toggle reflects aria-pressed=true when dockOpen', () => {
    render(<WindowFrame {...baseProps} dockOpen={true} />)
    expect(screen.getByRole('button', { name: /toggle shelf/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('B2: backlinks toggle renders, reflects backlinksOpen, and fires onToggleBacklinks', () => {
    const onToggleBacklinks = vi.fn()
    render(
      <WindowFrame {...baseProps} backlinksOpen={false} onToggleBacklinks={onToggleBacklinks} />,
    )
    const toggle = screen.getByRole('button', { name: /toggle backlinks/i })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(onToggleBacklinks).toHaveBeenCalledOnce()
  })

  it('B2: backlinks toggle reflects aria-pressed=true when backlinksOpen', () => {
    render(<WindowFrame {...baseProps} backlinksOpen={true} />)
    expect(screen.getByRole('button', { name: /toggle backlinks/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('canvas toggle button calls onViewChange("canvas")', () => {
    const onViewChange = vi.fn()
    render(<WindowFrame {...baseProps} view="feed" onViewChange={onViewChange} />)
    const canvasBtn = screen.getByRole('button', { name: /canvas view/i })
    // active view reflects aria-pressed so the quiet pill is assertable
    expect(canvasBtn).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /feed view/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(canvasBtn)
    expect(onViewChange).toHaveBeenCalledExactlyOnceWith('canvas')
  })
})
