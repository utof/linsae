import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders as render } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'
import { NoteBubble } from './NoteBubble'

// Shared no-op for the new required expand props.
const noop = () => {}

const baseNote: Note = {
  id: 'n1',
  slug: 'foo',
  body: 'hello',
  type: 'claim',
  created_at: 1737000000000,
  updated_at: 1737000000000,
  deleted_at: null,
}

describe('NoteBubble', () => {
  it('renders the body text', () => {
    render(
      <NoteBubble
        note={baseNote}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    expect(screen.getByText('hello')).toBeInTheDocument()
  })

  it('shows a yellow tint for question type', () => {
    const q: Note = { ...baseNote, type: 'question' }
    const { container } = render(
      <NoteBubble
        note={q}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    const bubble = container.querySelector('[data-bubble]') as HTMLElement
    // jsdom serializes background to either '#fffbf0' or 'rgb(255, 251, 240)'.
    const bg = bubble.style.background.toLowerCase()
    expect(bg.includes('fffbf0') || bg.includes('255, 251, 240')).toBe(true)
  })

  it('applies the focused/selected styling when focused=true', () => {
    const { container } = render(
      <NoteBubble
        note={baseNote}
        focused={true}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    const bubble = container.querySelector('[data-bubble]') as HTMLElement
    // Focused rail is an inset box-shadow (not border-left) so the focus
    // state doesn't shift bubble content by 1px. jsdom serialises the
    // accent in either hex or rgb form depending on engine version.
    const bs = bubble.style.boxShadow.toLowerCase()
    expect(bs.includes('0d99ff') || bs.includes('13, 153, 255')).toBe(true)
    expect(bs).toContain('inset')
  })

  it('calls onFocus when the bubble is clicked', () => {
    const onFocus = vi.fn()
    const { container } = render(
      <NoteBubble
        note={baseNote}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={onFocus}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    const bubble = container.querySelector('[data-bubble]')
    if (!bubble) throw new Error('bubble not found')
    fireEvent.click(bubble)
    expect(onFocus).toHaveBeenCalledOnce()
  })

  it('does NOT render the expand button when body is under the 4096-char cap', () => {
    render(
      <NoteBubble
        note={baseNote}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    expect(screen.queryByRole('button', { name: /expand note/i })).not.toBeInTheDocument()
  })

  it('renders the expand button with word count when body exceeds 4096 chars', () => {
    // 1100 words at ~5 chars each ≈ 5500 chars — comfortably over the cap.
    const longBody = Array.from({ length: 1100 }, (_, i) => `word${i}`).join(' ')
    render(
      <NoteBubble
        note={{ ...baseNote, body: longBody }}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    const btn = screen.getByRole('button', { name: /expand note — 1100 words/i })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveTextContent(/expand \(1,100 words\)/)
  })

  it('expand toggle: expanded=false truncates body; expanded=true reveals full body', () => {
    // Suffix marker placed PAST the 4096-char cap so a "rendered" assertion
    // proves the truncation actually lifted.
    const longBody = `${'x '.repeat(2100)}TAIL_MARKER`
    expect(longBody.length).toBeGreaterThan(4096)
    // Collapsed: TAIL_MARKER is past the cap, so it's not in the DOM.
    const { container: cCollapsed } = render(
      <NoteBubble
        note={{ ...baseNote, body: longBody }}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    expect(cCollapsed.textContent).not.toContain('TAIL_MARKER')
    // Expanded: full body is rendered.
    const { container: cExpanded } = render(
      <NoteBubble
        note={{ ...baseNote, body: longBody }}
        focused={false}
        expanded={true}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    expect(screen.getByRole('button', { name: /collapse note/i })).toBeInTheDocument()
    expect(cExpanded.textContent).toContain('TAIL_MARKER')
  })

  it('expand button click does NOT trigger onFocus (stops propagation)', () => {
    const onFocus = vi.fn()
    const longBody = 'x'.repeat(5000)
    render(
      <NoteBubble
        note={{ ...baseNote, body: longBody }}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={onFocus}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /expand note/i }))
    expect(onFocus).not.toHaveBeenCalled()
  })

  it('delete requires double-click within 2s', () => {
    const onDelete = vi.fn()
    const { container } = render(
      <NoteBubble
        note={baseNote}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={onDelete}
        onCopyLink={noop}
      />,
    )
    const bubble = container.querySelector('[data-bubble]')
    if (!bubble) throw new Error('bubble not found')
    // Hover the bubble first so the action bar mounts (hidden behind {hover && …}).
    fireEvent.mouseEnter(bubble)
    const trash = screen.getByTitle('delete')
    fireEvent.click(trash)
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(trash)
    expect(onDelete).toHaveBeenCalledOnce()
  })

  // ── Context menu tests ──────────────────────────────────────────────────────

  it('context menu does NOT appear without a contextmenu event', () => {
    render(
      <NoteBubble
        note={baseNote}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('right-click on the bubble opens the context menu', () => {
    const { container } = render(
      <NoteBubble
        note={baseNote}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    const bubble = container.querySelector('[data-bubble]')
    if (!bubble) throw new Error('bubble not found')
    fireEvent.contextMenu(bubble)
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('right-click does NOT call onFocus (avoids opening backlinks pane as a side-effect)', () => {
    const onFocus = vi.fn()
    const { container } = render(
      <NoteBubble
        note={baseNote}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={onFocus}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    const bubble = container.querySelector('[data-bubble]')
    if (!bubble) throw new Error('bubble not found')
    fireEvent.contextMenu(bubble)
    expect(onFocus).not.toHaveBeenCalled()
  })

  it('context menu Edit item calls onEdit and closes menu', () => {
    const onEdit = vi.fn()
    const { container } = render(
      <NoteBubble
        note={baseNote}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={onEdit}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    const bubble = container.querySelector('[data-bubble]')
    if (!bubble) throw new Error('bubble not found')
    fireEvent.contextMenu(bubble)
    fireEvent.click(screen.getByRole('menuitem', { name: /edit/i }))
    expect(onEdit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('context menu Copy link item calls onCopyLink and closes menu', () => {
    const onCopyLink = vi.fn()
    const { container } = render(
      <NoteBubble
        note={baseNote}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={onCopyLink}
      />,
    )
    const bubble = container.querySelector('[data-bubble]')
    if (!bubble) throw new Error('bubble not found')
    fireEvent.contextMenu(bubble)
    fireEvent.click(screen.getByRole('menuitem', { name: /copy link/i }))
    expect(onCopyLink).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('context menu Delete item calls onDelete directly (no arm pattern) and closes menu', () => {
    const onDelete = vi.fn()
    const { container } = render(
      <NoteBubble
        note={baseNote}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={onDelete}
        onCopyLink={noop}
      />,
    )
    const bubble = container.querySelector('[data-bubble]')
    if (!bubble) throw new Error('bubble not found')
    fireEvent.contextMenu(bubble)
    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }))
    expect(onDelete).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('Escape key closes the context menu', () => {
    const { container } = render(
      <NoteBubble
        note={baseNote}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    const bubble = container.querySelector('[data-bubble]')
    if (!bubble) throw new Error('bubble not found')
    fireEvent.contextMenu(bubble)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  // ── Footer (time + edited indicator) ──────────────────────────────────────

  it('renders a timestamp footer derived from created_at', () => {
    // Pick a fixed ms value and assert the rendered string contains the
    // formatted minute portion. Avoids locale brittleness on the hour
    // (12h vs 24h, AM/PM) and the date portion (locale-dependent month
    // abbreviation), both of which vary by the test runner's environment.
    const d = new Date()
    d.setHours(14, 23, 0, 0)
    const ms = d.getTime()
    render(
      <NoteBubble
        note={{ ...baseNote, created_at: ms, updated_at: ms }}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    // ":23" appears in both 12h ("2:23 PM") and 24h ("14:23") formats.
    expect(screen.getByText(/:23/)).toBeInTheDocument()
  })

  it('does NOT show the edited indicator when updated_at == created_at', () => {
    render(
      <NoteBubble
        note={{ ...baseNote, created_at: 1737000000000, updated_at: 1737000000000 }}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    // The hover toolbar's edit button (aria-label="edit") is conditionally
    // mounted on hover, so without mouseEnter the only "edited" semantic node
    // in the DOM should be absent. The edited pen icon uses aria-label="edited".
    expect(screen.queryByLabelText('edited')).not.toBeInTheDocument()
  })

  it('shows the edited indicator when updated_at > created_at', () => {
    render(
      <NoteBubble
        note={{ ...baseNote, created_at: 1737000000000, updated_at: 1737000060000 }}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    expect(screen.getByLabelText('edited')).toBeInTheDocument()
  })

  it('click outside closes the context menu', () => {
    const { container } = render(
      <div>
        <NoteBubble
          note={baseNote}
          focused={false}
          expanded={false}
          onToggleExpand={noop}
          onFocus={noop}
          onWikilinkClick={noop}
          onEdit={noop}
          onDelete={noop}
          onCopyLink={noop}
        />
        <div data-testid="outside">outside</div>
      </div>,
    )
    const bubble = container.querySelector('[data-bubble]')
    if (!bubble) throw new Error('bubble not found')
    fireEvent.contextMenu(bubble)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  // ── Prop-driven expand/collapse (Tasks 2+3) ───────────────────────────────

  it('renders truncated body with an expand affordance when over cap and expanded=false', () => {
    const longBody = 'x'.repeat(5000)
    render(
      <NoteBubble
        note={{ ...baseNote, body: longBody }}
        focused={false}
        expanded={false}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    expect(screen.getByRole('button', { name: /expand note/i })).toBeInTheDocument()
  })

  it('calls onToggleExpand with the note id when the expand control is clicked', () => {
    const onToggleExpand = vi.fn()
    const longBody = 'x'.repeat(5000)
    render(
      <NoteBubble
        note={{ ...baseNote, body: longBody }}
        focused={false}
        expanded={false}
        onToggleExpand={onToggleExpand}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /expand note/i }))
    expect(onToggleExpand).toHaveBeenCalledWith(baseNote.id)
  })

  it('shows the collapse affordance when expanded=true', () => {
    const longBody = 'x'.repeat(5000)
    render(
      <NoteBubble
        note={{ ...baseNote, body: longBody }}
        focused={false}
        expanded={true}
        onToggleExpand={noop}
        onFocus={noop}
        onWikilinkClick={noop}
        onEdit={noop}
        onDelete={noop}
        onCopyLink={noop}
      />,
    )
    expect(screen.getByRole('button', { name: /collapse note/i })).toBeInTheDocument()
  })
})
