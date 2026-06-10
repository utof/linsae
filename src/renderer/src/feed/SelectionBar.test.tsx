// src/renderer/src/feed/SelectionBar.test.tsx
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SelectionBar } from './SelectionBar'

const noop = () => {}

describe('SelectionBar', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the selected count on copy and delete', () => {
    render(<SelectionBar count={3} onCopy={noop} onDelete={noop} onCancel={noop} />)
    expect(screen.getByRole('button', { name: 'copy 3 notes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'delete 3 notes' })).toBeInTheDocument()
  })

  it('fires onCopy and onCancel directly', () => {
    const onCopy = vi.fn()
    const onCancel = vi.fn()
    render(<SelectionBar count={2} onCopy={onCopy} onDelete={noop} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'copy 2 notes' }))
    expect(onCopy).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'cancel selection' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('requires a second click within 2s to delete (armed confirm)', () => {
    const onDelete = vi.fn()
    render(<SelectionBar count={2} onCopy={noop} onDelete={onDelete} onCancel={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'delete 2 notes' }))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'confirm delete 2 notes' }))
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it('disarms after 2 seconds', () => {
    const onDelete = vi.fn()
    render(<SelectionBar count={1} onCopy={noop} onDelete={onDelete} onCancel={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'delete 1 notes' }))
    act(() => {
      vi.advanceTimersByTime(2100)
    })
    // armed state expired → this click re-arms instead of deleting
    fireEvent.click(screen.getByRole('button', { name: 'delete 1 notes' }))
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('underlines the c in copy and the d in delete without changing aria-labels', () => {
    render(<SelectionBar count={2} onCopy={noop} onDelete={noop} onCancel={noop} />)
    // aria-labels (the test contract everywhere else queries) are untouched.
    const copy = screen.getByRole('button', { name: 'copy 2 notes' })
    const del = screen.getByRole('button', { name: 'delete 2 notes' })
    // The mnemonic letter renders inside a <u> element.
    expect(copy.querySelector('u')?.textContent).toBe('c')
    expect(del.querySelector('u')?.textContent).toBe('d')
  })

  it('fires onCopy on a plain "c" keypress while mounted', () => {
    const onCopy = vi.fn()
    render(<SelectionBar count={2} onCopy={onCopy} onDelete={noop} onCancel={noop} />)
    fireEvent.keyDown(document, { key: 'c' })
    expect(onCopy).toHaveBeenCalledOnce()
  })

  it('"d" then "d" arms then fires onDelete (same path as clicking)', () => {
    const onDelete = vi.fn()
    render(<SelectionBar count={1} onCopy={noop} onDelete={onDelete} onCancel={noop} />)
    fireEvent.keyDown(document, { key: 'd' })
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'd' })
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it('ignores letters typed inside a textarea (typing guard)', () => {
    const onDelete = vi.fn()
    render(
      <div>
        <textarea data-testid="ta" />
        <SelectionBar count={1} onCopy={noop} onDelete={onDelete} onCancel={noop} />
      </div>,
    )
    const ta = screen.getByTestId('ta')
    fireEvent.keyDown(ta, { key: 'd' })
    fireEvent.keyDown(ta, { key: 'd' })
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('ignores modifier+letter (e.g. ⌘C copies text, not selection)', () => {
    const onCopy = vi.fn()
    render(<SelectionBar count={2} onCopy={onCopy} onDelete={noop} onCancel={noop} />)
    fireEvent.keyDown(document, { key: 'c', metaKey: true })
    fireEvent.keyDown(document, { key: 'c', ctrlKey: true })
    expect(onCopy).not.toHaveBeenCalled()
  })
})
