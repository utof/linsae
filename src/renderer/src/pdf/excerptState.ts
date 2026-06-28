import { create } from 'zustand'
import type { PdfLocator } from '../../../shared/types'

// Local type — NOT exported until Task 11 (useExcerptCapture) adds a consumer.
// Exporting an unused type fails the precommit knip gate (see rail-layout.ts:11).
interface PendingExcerpt {
  text: string
  locator: PdfLocator
  pdfId: string
  page: number
}

interface ExcerptState {
  /** The captured (but not-yet-committed) selection. Set on every selection. */
  pending: PendingExcerpt | null
  /**
   * True ONLY after the user clicks the explicit "Excerpt →" affordance.
   * The App bridge (Task 14) watches this — NOT `pending` — to create exactly
   * one note + arm canvas placement. Selecting text never sets this (B3:
   * prevents an orphan note on every selection / re-selection).
   */
  armed: boolean
  /** Capture a selection. Resets `armed` — a fresh selection is never auto-committed. */
  set: (e: PendingExcerpt) => void
  /** Affordance click: request placement of the current pending excerpt. No-op if none pending. */
  arm: () => void
  /** Reset pending + armed (Esc, or after the canvas places the note). */
  clear: () => void
}

/**
 * Pending-excerpt store — the bridge between the PDF pane's selection
 * capture and the canvas's ghost-placement commit. Mirrors the ADR 0040
 * command-registry pattern (client UI state only; no DB state).
 * Note creation is gated behind `armed` (an explicit affordance), so text
 * selection alone is side-effect-free (round-2 review B3).
 * @see docs/specs/v0.6-pdf-slim-slice.md §7 (capture→place)
 */
export const useExcerptStore = create<ExcerptState>((set) => ({
  pending: null,
  armed: false,
  set: (e) => set({ pending: e, armed: false }),
  arm: () => set((s) => (s.pending ? { armed: true } : {})),
  clear: () => set({ pending: null, armed: false }),
}))
