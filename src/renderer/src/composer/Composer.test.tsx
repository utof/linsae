import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders as render } from '../../../../tests/setup'
import { Composer } from './Composer'

// vitest.config.ts sets globals: false, so RTL's auto-cleanup (which is gated on
// `globalThis.afterEach`) is inert — without an explicit cleanup, every test in
// this file would leave its DOM in place and `screen.getByRole('textbox')` would
// find every prior render's textarea, throwing "Found multiple elements".
afterEach(cleanup)

describe('Composer', () => {
  it('Enter submits with mode=claim by default', () => {
    const onSubmit = vi.fn()
    render(<Composer onSubmit={onSubmit} initialBody="" initialMode="claim" onCancel={() => {}} />)
    const ta = screen.getByRole('textbox')
    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith({ body: 'hello', type: 'claim' })
  })

  it('Shift+Enter inserts a newline (does not submit)', () => {
    const onSubmit = vi.fn()
    render(<Composer onSubmit={onSubmit} initialBody="" initialMode="claim" onCancel={() => {}} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'a' } })
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('? on an empty composer flips mode to question', () => {
    render(<Composer onSubmit={() => {}} initialBody="" initialMode="claim" onCancel={() => {}} />)
    const ta = screen.getByRole('textbox')
    fireEvent.keyDown(ta, { key: '?' })
    expect(screen.getByText(/question/i)).toBeInTheDocument()
  })

  it('? on a non-empty composer is a literal character (no mode flip)', () => {
    const onSubmit = vi.fn()
    render(<Composer onSubmit={onSubmit} initialBody="" initialMode="claim" onCancel={() => {}} />)
    const ta = screen.getByRole('textbox')
    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.keyDown(ta, { key: '?' })
    // Pill text is "QUESTION — ESC TO CLEAR"; /question/i matches it when in
    // question mode, and is absent when in claim mode.
    expect(screen.queryByText(/question/i)).not.toBeInTheDocument()
  })

  it('Esc in question mode drops back to claim', () => {
    render(<Composer onSubmit={() => {}} initialBody="" initialMode="claim" onCancel={() => {}} />)
    const ta = screen.getByRole('textbox')
    fireEvent.keyDown(ta, { key: '?' })
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(screen.queryByText(/question/i)).not.toBeInTheDocument()
  })

  it('Esc when there is a body in edit mode calls onCancel', () => {
    const onCancel = vi.fn()
    render(
      <Composer
        onSubmit={() => {}}
        initialBody="prefilled"
        initialMode="claim"
        onCancel={onCancel}
        editMode
      />,
    )
    const ta = screen.getByRole('textbox')
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  // The 3 tests below assert React SyntheticEvent.stopPropagation() by
  // wrapping the Composer in a parent <div onKeyDown> sentinel: if the child
  // calls e.stopPropagation(), the parent React handler never fires. This is
  // the most reliable detector for React 19 — `fireEvent.keyDown(node, {
  // stopPropagation: spy })` does NOT spy on React's SyntheticEvent method
  // (the spy is attached to the native event init, not the SyntheticEvent
  // wrapper that React constructs at dispatch time).
  it('Esc in question mode stops propagation (so global handler does not also fire)', () => {
    let bubbled = false
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test sentinel only.
      <div
        onKeyDown={() => {
          bubbled = true
        }}
      >
        <Composer onSubmit={() => {}} initialBody="" initialMode="claim" onCancel={() => {}} />
      </div>,
    )
    const ta = screen.getByRole('textbox')
    fireEvent.keyDown(ta, { key: '?' })
    bubbled = false // discard the '?' keydown which legitimately bubbles
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(bubbled).toBe(false)
  })

  it('Esc in edit mode stops propagation', () => {
    let bubbled = false
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test sentinel only.
      <div
        onKeyDown={() => {
          bubbled = true
        }}
      >
        <Composer
          onSubmit={() => {}}
          initialBody="prefilled"
          initialMode="claim"
          onCancel={() => {}}
          editMode
        />
      </div>,
    )
    const ta = screen.getByRole('textbox')
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(bubbled).toBe(false)
  })

  it('Esc in plain claim mode (no edit, no question) does NOT stopPropagation — lets global handler fire', () => {
    let bubbled = false
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test sentinel only.
      <div
        onKeyDown={() => {
          bubbled = true
        }}
      >
        <Composer onSubmit={() => {}} initialBody="" initialMode="claim" onCancel={() => {}} />
      </div>,
    )
    const ta = screen.getByRole('textbox')
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(bubbled).toBe(true)
  })
})
