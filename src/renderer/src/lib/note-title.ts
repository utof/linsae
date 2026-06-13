/**
 * Derive a display title from a note body: first non-empty line, markdown
 * syntax stripped, clamped to 80 chars, slug fallback. The ONLY title
 * source for: motion-LOD placeholders (this plan), picker rows, shelf rows,
 * placement banner, recent popover (Plan 3) — spec §3 title derivation.
 * Why regex stripping (not a markdown parse): titles are glanceable labels;
 * a full parse per row is wasted work and this stays dependency-free.
 * @see docs/specs/v0.4-canvas-mvp.md §3
 */
const MAX = 80

export function noteTitle(note: { body: string; slug: string }): string {
  const line = note.body.split('\n').find((l) => l.trim().length > 0)
  if (!line) return note.slug
  const stripped = line
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)+/, '') // heading/list/quote markers
    .replace(/\[\[([^\]]+)\]\]/g, '$1') // wikilinks
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // md links/images
    .replace(/(\*\*|__|\*|_|`|~~)/g, '') // emphasis/code fences
    .trim()
  if (stripped.length === 0) return note.slug
  // Clamp on code points, not UTF-16 units — String.prototype.slice can split
  // a surrogate pair (emoji, 𝕏) into mojibake before the ellipsis. Spec §3
  // says "~80 chars", so code-point counting is in-spec.
  const points = [...stripped]
  return points.length > MAX ? `${points.slice(0, MAX - 1).join('')}…` : stripped
}
