// @vitest-environment happy-dom
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { renderWithProviders } from '../../../../tests/setup'
import { SimpleComposer } from './SimpleComposer'

it('calls onSubmit with the typed body on Enter and clears', async () => {
  const onSubmit = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} />)
  const ta = screen.getByRole('textbox')
  fireEvent.change(ta, { target: { value: 'a reply' } })
  fireEvent.keyDown(ta, { key: 'Enter' }) // Enter sends (ADR 0001)
  // onSubmit is invoked on the same stack as the keydown, so it stays a plain
  // assertion. The CLEAR does not: `submit()` awaits onSubmit before clearing
  // (clear-on-success), which defers it by ≥1 microtask.
  // @see docs/plans/v0.8.2-composer-dataloss.md §2.3 A0
  expect(onSubmit).toHaveBeenCalledWith('a reply')
  await waitFor(() => expect((ta as HTMLTextAreaElement).value).toBe(''))
})

it('renders a send button that submits the trimmed draft and clears (Task 4)', async () => {
  const onSubmit = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} />)
  const ta = screen.getByRole('textbox')
  const send = screen.getByRole('button', { name: /add note/i })
  expect(send).toBeInTheDocument()
  fireEvent.change(ta, { target: { value: '  via button  ' } })
  fireEvent.click(send)
  expect(onSubmit).toHaveBeenCalledWith('via button')
  // Post-await clear — see the Enter test above.
  await waitFor(() => expect((ta as HTMLTextAreaElement).value).toBe(''))
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

it('calls onDraftClear when a note is sent via Enter (clear-and-cancel)', async () => {
  const onDraftClear = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={vi.fn()} onDraftClear={onDraftClear} />)
  const ta = screen.getByRole('textbox')
  fireEvent.change(ta, { target: { value: 'a reply' } })
  fireEvent.keyDown(ta, { key: 'Enter' })
  // Fires on the success branch, after `submit()` awaits onSubmit — post-await.
  await waitFor(() => expect(onDraftClear).toHaveBeenCalledOnce())
})

it('calls onDraftClear when a note is sent via the send button', async () => {
  const onDraftClear = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={vi.fn()} onDraftClear={onDraftClear} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'via button' } })
  fireEvent.click(screen.getByRole('button', { name: /add note/i }))
  await waitFor(() => expect(onDraftClear).toHaveBeenCalledOnce())
})

it('does NOT call onDraftClear on a whitespace-only no-op submit', async () => {
  const onDraftClear = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={vi.fn()} onDraftClear={onDraftClear} />)
  const ta = screen.getByRole('textbox')
  fireEvent.change(ta, { target: { value: '   ' } })
  fireEvent.keyDown(ta, { key: 'Enter' })
  // A NEGATIVE must not use waitFor: waitFor resolves on its first passing tick,
  // so it would pass vacuously against a call that lands a microtask later — it
  // can only prove "eventually true", never "never happens". Yield a full
  // macrotask turn instead; a setTimeout(0) runs only after the entire microtask
  // queue (and anything it enqueues) has drained, so once `submit()` awaits, a
  // wrongly-deferred onDraftClear would already have run by the assertion.
  // @see docs/plans/v0.8.2-composer-dataloss.md §2.3 A0
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  expect(onDraftClear).not.toHaveBeenCalled()
})
