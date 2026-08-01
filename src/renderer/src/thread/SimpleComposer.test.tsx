// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { flushMicrotasks } from '../../../../tests/flush'
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
  // can only prove "eventually true", never "never happens". `flushMicrotasks`
  // yields a full macrotask turn instead, after the whole microtask queue has
  // drained. @see tests/flush.ts
  await flushMicrotasks()
  expect(onDraftClear).not.toHaveBeenCalled()
})

// ── v0.8.2 A1/A2: clear-on-success contract ─────────────────────────────────
// A composer never clears its own draft optimistically. It awaits `onSubmit`
// and clears ONLY on resolve; on rejection the textarea, the persisted draft
// entry, and the user's keystrokes all survive untouched.
// @issue utof/linsae#161 · @see docs/plans/v0.8.2-composer-dataloss.md §2.2

/**
 * An `onSubmit` the test settles by hand, so assertions can run WHILE the post
 * is in flight. `resolve!` carries a definite-assignment assertion: the Promise
 * executor runs synchronously, but TS's control-flow analysis cannot see that
 * and would otherwise narrow the binding to `null` forever.
 */
function pendingSubmit() {
  let resolve!: () => void
  const onSubmit = vi.fn(
    (_body: string) =>
      new Promise<void>((r) => {
        resolve = r
      }),
  )
  return { onSubmit, settle: () => resolve() }
}

it('keeps the draft AND the persisted entry when onSubmit rejects (#161)', async () => {
  // The real throw site: two short identical replies collide on the body-derived
  // slug and `save-note.ts:164` rejects. @see src/main/save-note.ts
  const onSubmit = vi.fn(async () => {
    throw new Error('a note named "yes" already exists')
  })
  const onDraftClear = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} onDraftClear={onDraftClear} />)
  const ta = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: 'yes' } })
  fireEvent.keyDown(ta, { key: 'Enter' })

  await flushMicrotasks()
  expect(onSubmit).toHaveBeenCalledWith('yes')
  // (a) the on-screen text survives …
  expect(ta.value).toBe('yes')
  // (b) … and so does the durable `composer.draft.thread.v1` entry. Dropping it
  // is the half of #161 that survives a restart, so this is a hard negative —
  // flush, never waitFor.
  expect(onDraftClear).not.toHaveBeenCalled()
})

it('clears the draft and the persisted entry ONLY once onSubmit has resolved', async () => {
  // Deliberately gated on a promise the test settles by hand. A test that mocks
  // onSubmit to resolve immediately and asserts "the draft cleared" passes
  // against the buggy optimistic clear and the fixed one identically — it is
  // worthless. @see docs/plans/v0.8.2-composer-dataloss.md §7
  const { onSubmit, settle } = pendingSubmit()
  const onDraftClear = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} onDraftClear={onDraftClear} />)
  const ta = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: 'yes' } })
  fireEvent.keyDown(ta, { key: 'Enter' })

  await flushMicrotasks()
  // Still in flight — nothing has been cleared. The optimistic clear failed
  // exactly here: it discarded both on the same stack as the keydown.
  expect(ta.value).toBe('yes')
  expect(onDraftClear).not.toHaveBeenCalled()

  settle()
  await flushMicrotasks()
  expect(ta.value).toBe('')
  expect(onDraftClear).toHaveBeenCalledOnce()
})

it('accepts a retry after a rejected post (the in-flight flag is released)', async () => {
  const onSubmit = vi.fn<(body: string) => Promise<void>>()
  onSubmit.mockRejectedValueOnce(new Error('a note named "yes" already exists'))
  onSubmit.mockResolvedValueOnce(undefined)
  const onDraftClear = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} onDraftClear={onDraftClear} />)
  const ta = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: 'yes' } })
  fireEvent.keyDown(ta, { key: 'Enter' })
  await flushMicrotasks()

  // Without the `finally`, `inFlight` stays true here and the composer is dead
  // for the rest of this mount — text preserved, but permanently unpostable
  // behind an error the user cannot act on. Arguably worse than #161 itself.
  fireEvent.keyDown(ta, { key: 'Enter' })
  await flushMicrotasks()

  expect(onSubmit).toHaveBeenCalledTimes(2)
  expect(ta.value).toBe('')
  expect(onDraftClear).toHaveBeenCalledOnce()
})

it('ignores a second submit while the first is still in flight (double-submit guard)', async () => {
  // Enter held down, or a double-click on the send button: the second
  // `notes.create` for the same body is itself a duplicate-slug throw.
  const { onSubmit, settle } = pendingSubmit()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} />)
  const ta = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: 'yes' } })
  fireEvent.keyDown(ta, { key: 'Enter' })
  fireEvent.keyDown(ta, { key: 'Enter' })
  fireEvent.click(screen.getByRole('button', { name: /add note/i }))

  // Fire-then-flush-then-count. `waitFor(() => expect(fn).toHaveBeenCalledOnce())`
  // could NOT guard this: it resolves at the first tick where the count is 1, so
  // a second call landing later stays invisible.
  await flushMicrotasks()
  expect(onSubmit).toHaveBeenCalledTimes(1)

  settle()
  await flushMicrotasks()
  expect(ta.value).toBe('')
})

it('keeps keystrokes typed WHILE the post is in flight (no clobber)', async () => {
  const { onSubmit, settle } = pendingSubmit()
  const onDraftClear = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} onDraftClear={onDraftClear} />)
  const ta = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: 'yes' } })
  fireEvent.keyDown(ta, { key: 'Enter' })
  // The user keeps typing during the in-flight create.
  fireEvent.change(ta, { target: { value: 'yes — and one more thing' } })

  settle()
  await flushMicrotasks()
  // A bare `setBody('')` after the await would discard these keystrokes.
  expect(ta.value).toBe('yes — and one more thing')
  // And the persisted entry must NOT be dropped: it still holds live text, so
  // clearing it would diverge the durable draft from what is on screen.
  expect(onDraftClear).not.toHaveBeenCalled()
})

it('renders the parent-owned error and asks the parent to clear it on the next keystroke', () => {
  const onClearError = vi.fn()
  renderWithProviders(
    <SimpleComposer
      onSubmit={vi.fn()}
      error='a note named "yes" already exists'
      onClearError={onClearError}
    />,
  )
  // The failure must be VISIBLE — a fixed clear with no error surface converts
  // silent data-loss into silent nothing-happening.
  // @see docs/plans/v0.8.2-composer-dataloss.md §9
  expect(screen.getByRole('alert')).toHaveTextContent('a note named "yes" already exists')

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'yes!' } })
  // Composer-local error state is banned (plan §2.2.3) — it asks the owner.
  expect(onClearError).toHaveBeenCalledOnce()
})
