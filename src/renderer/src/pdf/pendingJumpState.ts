import { create } from 'zustand'
import type { PdfLocator } from '../../../shared/types'

// Local type — NOT exported until a consumer exists (the PdfReader drain).
// Exporting an unused type fails the precommit knip gate (see excerptState.ts:4-5).
interface PendingJump {
  pdfId: string
  locator: PdfLocator
}

interface PendingJumpState {
  /** The requested-but-not-yet-performed jump. Null once drained. */
  pending: PendingJump | null
  /**
   * Request that `pdfId` be reopened at `locator`. Overwrites any undrained
   * request — the newest read-back click wins; jumps never queue.
   */
  setPendingJump: (pdfId: string, locator: PdfLocator) => void
  /**
   * Read the pending jump AND clear it, in one call. Consumed-once by design:
   * the PdfReader drain re-runs on every render and every document swap, so a
   * jump left in the store would re-fire forever.
   */
  consumePendingJump: () => PendingJump | null
}

/**
 * Pending-jump store — the bridge from a note's read-back affordance to the PDF
 * reader, which cannot be reached by prop from a prop-free `NoteBubble`. Mirrors
 * `excerptState.ts` (client UI state only; no DB state), but consumed-once rather
 * than explicitly cleared, since the reader is the sole reader of each request.
 * @see docs/specs/v0.8-multipage-pdf.md §5.2
 * @issue utof/linsae#155
 */
export const usePendingJumpStore = create<PendingJumpState>((set, get) => ({
  pending: null,
  setPendingJump: (pdfId, locator) => set({ pending: { pdfId, locator } }),
  // get()+set() is atomic here: the whole body runs in one synchronous tick, so
  // two callers can never both observe the same non-null pending.
  consumePendingJump: () => {
    const pending = get().pending
    if (pending) set({ pending: null })
    return pending
  },
}))
