// @vitest-environment jsdom
/**
 * Component tests for ThreadComposer.
 *
 * (a) chip shows formatClock of live playhead when unfocused + empty.
 * (b) focusing the textarea then advancing livePlayhead keeps chip frozen at focus-time.
 * (c) typing + pressing Enter calls onPost({ body, t }) with the frozen t.
 * (d) Camera button calls onCapture if provided.
 * (e) clicking the chip reveals a manual mm:ss input; entering a valid time updates the chip.
 *
 * No QueryClient needed (purely presentational). Plain render suffices.
 *
 * @see src/renderer/src/thread/ThreadComposer.tsx
 * @see docs/specs/v0.2-youtube-annotation.md §Composer
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThreadComposer } from './ThreadComposer'

function makeProps(overrides: Partial<Parameters<typeof ThreadComposer>[0]> = {}) {
  return {
    livePlayhead: 30,
    onPost: vi.fn(),
    ...overrides,
  }
}

describe('ThreadComposer', () => {
  it('(a) chip shows formatClock of livePlayhead when unfocused and empty', () => {
    // 30 s → "0:30"
    render(<ThreadComposer {...makeProps({ livePlayhead: 30 })} />)
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('0:30')
  })

  it('(a) chip updates as livePlayhead prop changes while unfocused + empty', () => {
    const { rerender } = render(<ThreadComposer {...makeProps({ livePlayhead: 30 })} />)
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('0:30')

    rerender(<ThreadComposer {...makeProps({ livePlayhead: 65 })} />)
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('1:05')
  })

  it('(b) focusing textarea freezes chip at playhead; advancing livePlayhead does not change chip', () => {
    const { rerender } = render(<ThreadComposer {...makeProps({ livePlayhead: 50 })} />)

    // Focus the textarea → chip freezes at 50 ("0:50")
    const textarea = screen.getByRole('textbox')
    fireEvent.focus(textarea)
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('0:50')

    // Advance the prop to 80 s — chip must still show 0:50
    rerender(<ThreadComposer {...makeProps({ livePlayhead: 80 })} />)
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('0:50')
  })

  it('(c) typing + Enter calls onPost with frozen t and draft body', () => {
    const onPost = vi.fn()
    render(<ThreadComposer {...makeProps({ livePlayhead: 50, onPost })} />)

    const textarea = screen.getByRole('textbox')
    // Focus freezes at 50
    fireEvent.focus(textarea)
    // Type a draft
    fireEvent.change(textarea, { target: { value: 'great insight' } })
    // Enter submits
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    expect(onPost).toHaveBeenCalledOnce()
    expect(onPost).toHaveBeenCalledWith({ body: 'great insight', t: 50 })
  })

  it('(c) Shift+Enter does NOT submit', () => {
    const onPost = vi.fn()
    render(<ThreadComposer {...makeProps({ onPost })} />)

    const textarea = screen.getByRole('textbox')
    fireEvent.focus(textarea)
    fireEvent.change(textarea, { target: { value: 'draft text' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(onPost).not.toHaveBeenCalled()
  })

  it('(c) submitting clears draft and chip resumes live-tracking', () => {
    const onPost = vi.fn()
    const { rerender } = render(<ThreadComposer {...makeProps({ livePlayhead: 50, onPost })} />)

    const textarea = screen.getByRole('textbox')
    fireEvent.focus(textarea)
    fireEvent.change(textarea, { target: { value: 'note text' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    // After submit the textarea should be empty and chip should resume live-tracking.
    // Re-render with a new livePlayhead; chip should update.
    rerender(<ThreadComposer {...makeProps({ livePlayhead: 90, onPost })} />)
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('1:30')
  })

  it('(d) Camera button calls onCapture when provided', () => {
    const onCapture = vi.fn()
    render(<ThreadComposer {...makeProps({ onCapture })} />)

    fireEvent.click(screen.getByRole('button', { name: /capture frame/i }))
    expect(onCapture).toHaveBeenCalledOnce()
  })

  it('(d) Camera button is present even without onCapture (no error)', () => {
    render(<ThreadComposer {...makeProps()} />)
    expect(screen.getByRole('button', { name: /capture frame/i })).toBeInTheDocument()
  })

  it('(e) clicking chip opens manual time input', () => {
    render(<ThreadComposer {...makeProps({ livePlayhead: 30 })} />)

    fireEvent.click(screen.getByTestId('composer-chip'))
    // A text input for manual entry should appear
    expect(screen.getByTestId('chip-time-input')).toBeInTheDocument()
  })

  it('(e) entering a valid mm:ss in the chip input updates the frozen time', () => {
    render(<ThreadComposer {...makeProps({ livePlayhead: 30 })} />)

    fireEvent.click(screen.getByTestId('composer-chip'))
    const input = screen.getByTestId('chip-time-input')

    // Enter "1:15" → 75 s
    fireEvent.change(input, { target: { value: '1:15' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // Chip should now display 1:15; input should be dismissed
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('1:15')
    expect(screen.queryByTestId('chip-time-input')).toBeNull()
  })

  it('(e) entering an invalid time in the chip input does not update the chip', () => {
    render(<ThreadComposer {...makeProps({ livePlayhead: 30 })} />)

    fireEvent.click(screen.getByTestId('composer-chip'))
    const input = screen.getByTestId('chip-time-input')

    // "abc" is not valid mm:ss
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // Chip stays at 0:30; input dismissed
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('0:30')
  })

  it('(e) Escape on chip input dismisses without changing time', () => {
    render(<ThreadComposer {...makeProps({ livePlayhead: 30 })} />)

    fireEvent.click(screen.getByTestId('composer-chip'))
    const input = screen.getByTestId('chip-time-input')
    fireEvent.change(input, { target: { value: '2:00' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByTestId('chip-time-input')).toBeNull()
    expect(screen.getByTestId('composer-chip')).toHaveTextContent('0:30')
  })

  it('pendingFrame thumbnail renders when prop is set', () => {
    render(
      <ThreadComposer
        {...makeProps()}
        pendingFrame={{ thumbnailUrl: 'http://example.com/img.jpg', t: 30 }}
      />,
    )
    const img = screen.getByRole('img', { name: /frame/i })
    expect(img).toHaveAttribute('src', 'http://example.com/img.jpg')
  })

  it('pendingFrame thumbnail absent when prop is null', () => {
    render(<ThreadComposer {...makeProps()} pendingFrame={null} />)
    expect(screen.queryByRole('img', { name: /frame/i })).toBeNull()
  })

  it('onManualSeekEntry called when chip time is updated via the input', () => {
    const onManualSeekEntry = vi.fn()
    render(<ThreadComposer {...makeProps({ livePlayhead: 30, onManualSeekEntry })} />)

    fireEvent.click(screen.getByTestId('composer-chip'))
    const input = screen.getByTestId('chip-time-input')
    fireEvent.change(input, { target: { value: '2:30' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onManualSeekEntry).toHaveBeenCalledOnce()
    expect(onManualSeekEntry).toHaveBeenCalledWith(150) // 2*60+30
  })
})
