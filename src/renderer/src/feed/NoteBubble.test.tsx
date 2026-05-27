import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders as render } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'
import { NoteBubble } from './NoteBubble'

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
        onFocus={() => {}}
        onWikilinkClick={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onCopyLink={() => {}}
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
        onFocus={() => {}}
        onWikilinkClick={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onCopyLink={() => {}}
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
        onFocus={() => {}}
        onWikilinkClick={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onCopyLink={() => {}}
      />,
    )
    const bubble = container.querySelector('[data-bubble]') as HTMLElement
    // jsdom serializes borderLeftColor as either '#0d99ff' or 'rgb(13, 153, 255)'.
    const blc = bubble.style.borderLeftColor.toLowerCase()
    expect(blc.includes('0d99ff') || blc.includes('13, 153, 255')).toBe(true)
  })

  it('calls onFocus when the bubble is clicked', () => {
    const onFocus = vi.fn()
    const { container } = render(
      <NoteBubble
        note={baseNote}
        focused={false}
        onFocus={onFocus}
        onWikilinkClick={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onCopyLink={() => {}}
      />,
    )
    const bubble = container.querySelector('[data-bubble]')
    if (!bubble) throw new Error('bubble not found')
    fireEvent.click(bubble)
    expect(onFocus).toHaveBeenCalledOnce()
  })

  it('delete requires double-click within 2s', () => {
    const onDelete = vi.fn()
    const { container } = render(
      <NoteBubble
        note={baseNote}
        focused={false}
        onFocus={() => {}}
        onWikilinkClick={() => {}}
        onEdit={() => {}}
        onDelete={onDelete}
        onCopyLink={() => {}}
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
})
