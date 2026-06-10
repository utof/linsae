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
})
