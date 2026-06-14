/**
 * Shared title-line extraction — the ONE parse feeding slug identity
 * (`slugFromBody`), the renderer display title (`noteTitle`), and the
 * main-side `notes:listTitles` / FTS result titles. Lives in `src/shared/`
 * (imported by both main + renderer) so the slug and the display title can
 * never drift — they share `titleLine`, diverging only at the end (slug
 * lower+collapses for identity; display strips inline markdown + keeps case).
 * No persisted `title` column: the display title is derived on read.
 * @see docs/specs/v0.5-command-search.md §2 (decision 7 — slug reuse)
 * @issue utof/linsae#105 (display-strip cases)
 */

/** Display-title clamp, in code points (matches the prior renderer MAX). */
const MAX = 80

/**
 * The shared first step: first non-empty body line, leading `#`-heading
 * marker stripped, trimmed. Empty string when the body has no non-empty line.
 * Slug keeps the raw markdown chars after this; display title strips them.
 */
export function titleLine(body: string): string {
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return ''
  return line.replace(/^#+\s*/, '').trim()
}

/**
 * Display title: `titleLine` with inline markdown stripped + case preserved,
 * clamped to {@link MAX} code points. Returns '' when nothing renderable
 * remains — callers fall back to the slug (renderer `noteTitle`, listTitles).
 * Why regex stripping (not a markdown parse): titles are glanceable labels;
 * a full parse per row is wasted work and stays dependency-free.
 */
export function deriveTitle(body: string): string {
  const raw = titleLine(body)
  if (raw === '') return ''
  const stripped = raw
    .replace(/^\s*(?:[-*+]\s+|\d+\.\s+|>\s*)+/, '') // list/quote markers (heading already gone)
    .replace(/^\[[ xX]\]\s*/, '') // task checkbox `[ ]` / `[x]`
    .replace(/\[\[([^\]]+)\]\]/g, '$1') // wikilinks
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // md links/images
    .replace(/(\*\*|__|\*|_|`|~~)/g, '') // emphasis/code
    .trim()
  if (stripped.length === 0) return ''
  // Clamp on code points (not UTF-16 units) so an emoji/surrogate pair never
  // splits into mojibake before the ellipsis. Spec §3 says "~80 chars".
  const points = [...stripped]
  return points.length > MAX ? `${points.slice(0, MAX - 1).join('')}…` : stripped
}
