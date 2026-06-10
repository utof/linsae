/**
 * ReopenEditor — opens the AnnotateEditor on an already-posted screenshot.
 *
 * Fetches the attachment's saved overlay scene via `useOverlayScene` and mounts
 * `AnnotateEditor` on it (an empty scene when `overlay_path` is null). The editor
 * persists on Done; this wrapper additionally invalidates the thread's commentsOf
 * query so the Rail re-reads the (possibly newly-set) `overlay_path` and renders
 * the drawing immediately.
 *
 * **B-4 (null→path invalidation):** a *first* annotation flips `overlay_path`
 * `null→path`, but the Rail's `attachment` comes from the `['thread', noteId]`
 * commentsOf query — NOT the `['overlay', id]` key that `saveOverlay` invalidates.
 * So after a save we also invalidate `['thread', noteId]`; otherwise the first
 * annotation stays invisible until an unrelated refetch.
 *
 * Why a separate wrapper (not inline in the editor): `useOverlayScene` is a hook
 * (can't be called imperatively before mount), and the `['thread', noteId]`
 * invalidation is thread-specific knowledge the context-free editor must not hold.
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Reopen a posted screenshot"
 * @see src/renderer/src/annotate/AnnotateEditor.tsx
 * @see src/renderer/src/annotate/useOverlay.ts (useOverlayScene)
 */

import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import type { Attachment } from '../../../shared/types'
import { AnnotateEditor } from './AnnotateEditor'
import { useOverlayScene } from './useOverlay'

export interface ReopenEditorProps {
  /** The posted screenshot attachment to edit. */
  attachment: Attachment
  /**
   * The video-note id whose commentsOf query (`['thread', noteId]`) feeds the
   * Rail. Invalidated after a save so the Rail re-reads the new `overlay_path`.
   */
  noteId: string
  /** Called when the editor finishes (the caller unmounts the modal). */
  onClose: () => void
}

/**
 * Loads the saved scene then renders the editor; invalidates the thread query
 * after a save (B-4). See module docs.
 */
export function ReopenEditor({
  attachment,
  noteId,
  onClose,
}: ReopenEditorProps): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const { scene, loading } = useOverlayScene(attachment)

  const handleClose = useCallback(
    (saved: boolean) => {
      if (saved) {
        // B-4: the Rail's attachment comes from the commentsOf query, not the
        // ['overlay', id] key saveOverlay invalidated — refresh it so a first
        // annotation (overlay_path null→path) appears immediately.
        void queryClient.invalidateQueries({ queryKey: ['thread', noteId] })
      }
      onClose()
    },
    [queryClient, noteId, onClose],
  )

  // Wait for the read query to settle before mounting the editor so reopen lands
  // on the saved scene (not a transient empty one). A null overlay_path resolves
  // immediately (the hook returns scene:null, loading:false, no fetch).
  if (loading) return null

  return (
    <AnnotateEditor
      attachment={attachment}
      initialScene={scene}
      onClose={handleClose}
      escMode="changes"
    />
  )
}
