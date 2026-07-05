// @vitest-environment happy-dom
import { fireEvent, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { renderWithProviders } from '../../../../tests/setup'
import { SimpleComposer } from './SimpleComposer'

it('calls onSubmit with the typed body on Enter and clears', () => {
  const onSubmit = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} />)
  const ta = screen.getByRole('textbox')
  fireEvent.change(ta, { target: { value: 'a reply' } })
  fireEvent.keyDown(ta, { key: 'Enter' }) // Enter sends (ADR 0001)
  expect(onSubmit).toHaveBeenCalledWith('a reply')
  expect((ta as HTMLTextAreaElement).value).toBe('')
})

it('renders a send button that submits the trimmed draft and clears (Task 4)', () => {
  const onSubmit = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} />)
  const ta = screen.getByRole('textbox')
  const send = screen.getByRole('button', { name: /add note/i })
  expect(send).toBeInTheDocument()
  fireEvent.change(ta, { target: { value: '  via button  ' } })
  fireEvent.click(send)
  expect(onSubmit).toHaveBeenCalledWith('via button')
  expect((ta as HTMLTextAreaElement).value).toBe('')
})

it('the send button does not submit a whitespace-only draft (trim-empty guard)', () => {
  const onSubmit = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
  fireEvent.click(screen.getByRole('button', { name: /add note/i }))
  expect(onSubmit).not.toHaveBeenCalled()
})

it('Shift+Enter inserts a newline and does not submit', () => {
  const onSubmit = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} />)
  const ta = screen.getByRole('textbox')
  fireEvent.change(ta, { target: { value: 'line1' } })
  fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
  expect(onSubmit).not.toHaveBeenCalled()
})

it('does not submit on Enter when the body is whitespace-only (trim-empty guard)', () => {
  const onSubmit = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} />)
  const ta = screen.getByRole('textbox')
  fireEvent.change(ta, { target: { value: '   ' } })
  fireEvent.keyDown(ta, { key: 'Enter' })
  expect(onSubmit).not.toHaveBeenCalled()
})

it('trims surrounding whitespace from the submitted body', () => {
  const onSubmit = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} />)
  const ta = screen.getByRole('textbox')
  fireEvent.change(ta, { target: { value: '  padded  ' } })
  fireEvent.keyDown(ta, { key: 'Enter' })
  expect(onSubmit).toHaveBeenCalledWith('padded')
})

// ── v0.7 Task 4.2: per-thread draft persistence ──────────────────────────────

it('seeds the textarea from initialDraft (Task 4.2 restore)', () => {
  renderWithProviders(<SimpleComposer onSubmit={vi.fn()} initialDraft="hello" />)
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('hello')
})

it('reports the full text via onDraftChange, but NOT on mount (skip-first)', () => {
  const onDraftChange = vi.fn()
  renderWithProviders(
    <SimpleComposer onSubmit={vi.fn()} initialDraft="hi" onDraftChange={onDraftChange} />,
  )
  // Seeded value must not echo back to disk on mount.
  expect(onDraftChange).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi there' } })
  // Reports the FULL new text (no rootId — App closes over the key).
  expect(onDraftChange).toHaveBeenCalledWith('hi there')
})

it('calls onDraftClear when a note is sent via Enter (clear-and-cancel)', () => {
  const onDraftClear = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={vi.fn()} onDraftClear={onDraftClear} />)
  const ta = screen.getByRole('textbox')
  fireEvent.change(ta, { target: { value: 'a reply' } })
  fireEvent.keyDown(ta, { key: 'Enter' })
  expect(onDraftClear).toHaveBeenCalledOnce()
})

it('calls onDraftClear when a note is sent via the send button', () => {
  const onDraftClear = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={vi.fn()} onDraftClear={onDraftClear} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'via button' } })
  fireEvent.click(screen.getByRole('button', { name: /add note/i }))
  expect(onDraftClear).toHaveBeenCalledOnce()
})

it('does NOT call onDraftClear on a whitespace-only no-op submit', () => {
  const onDraftClear = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={vi.fn()} onDraftClear={onDraftClear} />)
  const ta = screen.getByRole('textbox')
  fireEvent.change(ta, { target: { value: '   ' } })
  fireEvent.keyDown(ta, { key: 'Enter' })
  expect(onDraftClear).not.toHaveBeenCalled()
})
