/**
 * Derive a display title from a note body: first non-empty line, markdown
 * syntax stripped, clamped to 80 chars, slug fallback. The ONLY title
 * source for: motion-LOD placeholders (this plan), picker rows, shelf rows,
 * placement banner, recent popover (Plan 3) — spec §3 title derivation.
 * Delegates to the shared `deriveTitle` so the slug and the display title
 * parse the body once and can never drift (the strip logic now lives in
 * `src/shared/note-title.ts`).
 * @see docs/specs/v0.4-canvas-mvp.md §3
 * @see docs/specs/v0.5-command-search.md §2
 */
import { deriveTitle } from '../../../shared/note-title'

export function noteTitle(note: { body: string; slug: string }): string {
  return deriveTitle(note.body) || note.slug
}
