import { useCallback } from 'react'
import type { PdfLocator } from '../../../shared/types'
import { useDockStore } from '../panes/dockStore'
import { usePendingJumpStore } from './pendingJumpState'
import { useOpenPdf } from './usePdfOpenId'

/**
 * The ONE way to open the PDF reader — optionally at a captured locator.
 *
 * Why it exists as a hook rather than staying inline in `App`: the pane-opening
 * pair (`openPdf` + `openPane('pdf')`) lived in `App.handleOpenPdfReader`, a
 * `useCallback` reachable only as a prop (`App.tsx:1417`). `NoteBubble` also
 * renders under the generic thread child list, which passes no such prop
 * (`thread/ThreadView.tsx:937-949`), so a prop-driven read-back affordance would
 * be silently dead in threads — exactly where excerpt notes are read. Extracting
 * the pair is what lets the affordance be store-driven AND still route through
 * the one existing open path, which spec §5.2 requires simultaneously.
 *
 * Ordering is load-bearing: the jump is queued BEFORE `pdf.openDocId` is written.
 * That write is an async SQLite round-trip and the reader drains on the resulting
 * document change, so queueing afterwards could miss the drain entirely. Queueing
 * first is equally correct when the document is already open — the reader
 * subscribes to the store, so a same-document jump needs no document change at all.
 *
 * @returns `(pdfId, locator?)` — with a locator the reader scrolls to (and flashes)
 *   it; without one it opens wherever that document was last left (spec §6).
 * @see docs/specs/v0.8-multipage-pdf.md §5.2
 * @issue utof/linsae#155
 */
export function useOpenPdfAt(): (pdfId: string, locator?: PdfLocator) => void {
  const openPdf = useOpenPdf()
  return useCallback(
    (pdfId: string, locator?: PdfLocator) => {
      if (locator) usePendingJumpStore.getState().setPendingJump(pdfId, locator)
      // Async on purpose (the v0.6 behaviour this replaces): the setting write
      // makes the open survive a restart, while `openPane` below opens the dock
      // synchronously so the pane does not wait on the DB.
      void openPdf(pdfId)
      useDockStore.getState().openPane('pdf')
    },
    [openPdf],
  )
}
