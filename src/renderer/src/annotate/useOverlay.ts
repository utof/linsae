/**
 * React Query hooks for fetching and saving annotation overlays.
 *
 * **Read (`useOverlayScene`):**
 * - Keyed on `['overlay', attachment.id, attachment.overlay_path]` so the
 *   cache entry is naturally invalidated when `overlay_path` changes.
 * - Fetches the sidecar via `/_media/…` (same-origin, no IPC needed) using
 *   `{ cache: 'no-store' }` so an edited overlay is never served stale.
 *   Why no-store: the shell sends no ETag/Last-Modified validators
 *   (`http-shell.ts:158`), so the browser would otherwise cache indefinitely.
 * - Degrades silently: a missing or unparseable sidecar returns `scene: null`
 *   (no throw, no error UI — the frame just renders without an overlay).
 *
 * **Write (`saveOverlay`):**
 * - Serializes the scene via `serializeScene` (or passes `null` to clear).
 * - Calls the IPC facade `api.youtube.saveOverlay`.
 * - Invalidates `['overlay', attachment.id]` so every component holding a
 *   scene for this attachment re-fetches.
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §useOverlay
 * @see src/renderer/src/lib/media-url.ts (mediaUrlFromPath)
 * @see src/renderer/src/lib/api.ts (api.youtube.saveOverlay facade)
 */

import { type QueryClient, useQuery } from '@tanstack/react-query'
import type { Attachment } from '../../../shared/types'
import { parseScene, serializeScene } from '../ink/svg'
import type { Scene } from '../ink/types'
import { api } from '../lib/api'
import { mediaUrlFromPath } from '../lib/media-url'

// ---------------------------------------------------------------------------
// Read hook
// ---------------------------------------------------------------------------

/**
 * Fetches and parses the SVG sidecar for an attachment's overlay.
 *
 * Returns `{ scene: null }` when:
 * - `attachment.overlay_path` is null (no sidecar exists yet).
 * - The fetch returns a non-2xx status (e.g. 404 after a deletion race).
 * - The response body cannot be parsed as a valid scene.
 *
 * Why `cache: 'no-store'`: the sidecar path (`<attachmentId>.svg`) is stable
 * across edits, and the loopback shell omits HTTP validators, so the browser
 * would otherwise serve a cached copy after a save. `no-store` forces a fresh
 * read every time the query key changes or the query is invalidated.
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §useOverlay
 */
export function useOverlayScene(attachment: Attachment): { scene: Scene | null; loading: boolean } {
  const { data: scene = null, isLoading: loading } = useQuery({
    queryKey: ['overlay', attachment.id, attachment.overlay_path] as const,
    enabled: attachment.overlay_path != null,
    queryFn: async (): Promise<Scene | null> => {
      // overlay_path is non-null here (enabled guard above), but TypeScript
      // doesn't narrow through `enabled`, so we re-check defensively.
      const overlayPath = attachment.overlay_path
      if (!overlayPath) return null

      let text: string
      try {
        const res = await fetch(mediaUrlFromPath(overlayPath), { cache: 'no-store' })
        if (!res.ok) return null
        text = await res.text()
      } catch {
        // Network failure → degrade silently (no throw)
        return null
      }

      // parseScene never throws (svg.ts:113) — on garbage/unparseable input it
      // returns the sentinel { width:0, height:0, elements:[] }. Treat that as
      // "no overlay". This is safe: a legitimately-empty overlay never exists on
      // disk (the editor clears overlay_path to null + removes the sidecar when
      // all annotations are erased), and a real scene's width/height equal the
      // image dims (never 0). So {0,0,[]} only ever means garbage/dangling.
      const scene = parseScene(text)
      if (scene.width === 0 && scene.height === 0 && scene.elements.length === 0) {
        return null
      }
      return scene
    },
  })

  return { scene, loading }
}

// ---------------------------------------------------------------------------
// Write helper
// ---------------------------------------------------------------------------

/**
 * Serializes `scene` and writes it via the IPC facade, then invalidates the
 * overlay query cache for `attachment.id` so the Rail re-renders with the new
 * scene.
 *
 * Pass `scene: null` to clear the overlay (deletes the sidecar, nulls
 * `overlay_path`).
 *
 * Why standalone function (not a `useMutation` hook): the editor and capture
 * flow both need to call this outside a React render cycle (e.g. on Done /
 * Esc-keep). Callers obtain `queryClient` via `useQueryClient()`.
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §useOverlay (write path)
 */
export async function saveOverlay(
  queryClient: QueryClient,
  attachment: Attachment,
  scene: Scene | null,
): Promise<void> {
  const svg = scene !== null ? serializeScene(scene) : null
  await api.youtube.saveOverlay(attachment.id, svg)
  // Invalidate by [overlay, id] prefix so any overlay_path variant for this
  // attachment is refreshed (handles the case where overlay_path just changed).
  await queryClient.invalidateQueries({ queryKey: ['overlay', attachment.id] })
}
