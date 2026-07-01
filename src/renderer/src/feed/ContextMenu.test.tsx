import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders as render } from '../../../../tests/setup'
import { type ContextMenuItem, ContextMenuShell } from './ContextMenu'

const noop = () => {}

/**
 * B12: the menu button is a `display:flex` row with `gap:8` (for icon ↔ label
 * spacing). The mnemonic label used to render as a bare fragment, so the `<u>`
 * letter and the rest of the word became separate direct flex children and the
 * 8px gap split the word — "E dit" instead of "E̲dit". The fix wraps the split in
 * one inline <span>, making the whole label a single flex item.
 *
 * Falsification: revert the `<span>` back to a fragment and `u.parentElement`
 * becomes the button itself → the structural assertions below fail.
 */
describe('ContextMenuShell mnemonic label (B12)', () => {
  it('renders the mnemonic letter contiguous with the rest of the word (no flex-gap split)', () => {
    const items: ContextMenuItem[] = [
      { key: 'edit', label: 'Edit', icon: <span />, onClick: noop, mnemonic: 'e' },
    ]
    render(<ContextMenuShell pos={{ x: 0, y: 0 }} items={items} onClose={noop} />)
    const item = screen.getByRole('menuitem', { name: 'edit' })
    // Accessible name is the intact word (aria-label), unaffected by the split.
    expect(item).toHaveAttribute('aria-label', 'edit')
    // Visible word renders contiguously: "E" + "dit" = "Edit".
    expect(item).toHaveTextContent('Edit')
    const u = item.querySelector('u')
    expect(u?.textContent).toBe('E')
    // CRITICAL: the <u> and the remainder live in ONE inline wrapper, NOT as
    // separate direct children of the flex button (that is the gap bug).
    expect(u?.parentElement).not.toBe(item)
    expect(u?.parentElement?.tagName).toBe('SPAN')
    // The whole word sits inside that single wrapper (one flex item).
    expect(u?.parentElement).toHaveTextContent('Edit')
  })

  it('underlines the real mnemonic char when it is not the first letter, still contiguous', () => {
    const items: ContextMenuItem[] = [
      { key: 'shelf', label: '→ shelf', icon: <span />, onClick: noop, mnemonic: 's' },
    ]
    render(<ContextMenuShell pos={{ x: 0, y: 0 }} items={items} onClose={noop} />)
    const item = screen.getByRole('menuitem', { name: '→ shelf' })
    const u = item.querySelector('u')
    expect(u?.textContent).toBe('s')
    expect(u?.parentElement).not.toBe(item)
    expect(u?.parentElement?.tagName).toBe('SPAN')
    expect(u?.parentElement).toHaveTextContent('→ shelf')
  })

  it('renders a plain label (no mnemonic) unchanged', () => {
    const items: ContextMenuItem[] = [
      { key: 'noop', label: 'Plain', icon: <span />, onClick: noop },
    ]
    render(<ContextMenuShell pos={{ x: 0, y: 0 }} items={items} onClose={noop} />)
    const item = screen.getByRole('menuitem', { name: 'plain' })
    expect(item).toHaveTextContent('Plain')
    expect(item.querySelector('u')).toBeNull()
  })
})
