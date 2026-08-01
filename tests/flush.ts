import { act } from '@testing-library/react'

/**
 * Yield one full macrotask turn inside `act()`, so every pending microtask (and
 * anything those enqueue) has drained and every resulting React state update has
 * been applied before the next assertion runs.
 *
 * Why this exists rather than `waitFor`: `waitFor` resolves on its FIRST passing
 * tick, so it can only prove "eventually true" — it can never prove "never
 * happens". A negative assertion (`expect(onDraftClear).not.toHaveBeenCalled()`)
 * placed under `waitFor` passes vacuously against a call that lands a microtask
 * later. `setTimeout(…, 0)` runs only after the entire microtask queue has
 * drained, so a wrongly-deferred call would already have fired by the assertion.
 *
 * This is one more copy of an idiom the codebase already hand-rolls, added so
 * new sites import it instead of writing yet another. It did NOT replace the
 * existing ones — three inline copies remain and stay that way, notably
 * `src/renderer/src/pdf/useExcerptCapture.test.ts`, which dispatches an event
 * inside the same `act()` and so is not a drop-in.
 *
 * Kept OUT of `tests/setup.tsx` deliberately — that file is a `setupFiles` entry
 * with ~47 importers, and CLAUDE.md's inline-fix gate forbids non-trivial edits
 * to files with rg-fan-in > 20.
 *
 * @see docs/plans/v0.8.2-composer-dataloss.md §2.3 A0
 * @see tests/pdf-layout.ts (the sibling test-helper-module precedent)
 */
export async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
