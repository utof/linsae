import { normalizeSlug } from './slug'

/**
 * A parsed wikilink occurrence extracted from a markdown body.
 *
 * Why: The index stores wikilinks as structured records so that slug-based
 * resolution and display-text rendering can be handled independently.
 * On note rename, `raw` is used as the find-target for in-place replacement.
 * @see docs/specs/v0.1-rolling-feed-and-search.md
 */
export interface Wikilink {
  /** Normalized (trimmed, lowercased, whitespace-collapsed) lookup key. */
  slug: string
  /** Verbatim display text: after `|` if present, otherwise the target text. */
  display: string
  /** Verbatim section anchor (after `#`), or null if absent. */
  section: string | null
  /** The raw `[[…]]` substring as it appears in the source file. */
  raw: string
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

/**
 * Extract every `[[target]]` / `[[target|display]]` / `[[target#section]]` /
 * `[[target#section|display]]` occurrence from a markdown body.
 *
 * Returns parsed records with a normalized slug (for lookup), verbatim display
 * text (for rendering), verbatim section (for anchor navigation), and the raw
 * match string (for rename-replace).
 *
 * Why: Source-of-truth markdown files store wikilinks as typed by the user; the
 * index needs a normalized lookup key (slug) plus the original text for
 * replacement on rename. Empty `[[]]` brackets are silently skipped because they
 * produce an empty slug after normalization.
 * @see docs/specs/v0.1-rolling-feed-and-search.md
 */
export function extractWikilinks(body: string): Wikilink[] {
  const out: Wikilink[] = []
  for (const match of body.matchAll(WIKILINK_RE)) {
    // match[1] is always a string when the regex has one capture group and matched —
    // but noUncheckedIndexedAccess types it as string | undefined; guard defensively.
    const inner = match[1]
    if (inner === undefined) continue

    const parts = inner.split('|', 2)
    const beforePipe = parts[0] ?? ''
    const afterPipe = parts[1]

    const targetParts = beforePipe.split('#', 2)
    const targetPart = targetParts[0] ?? ''
    const sectionPart = targetParts[1]

    // When no pipe is present, display is the target (before any `#`) rather than
    // the full `target#section` string. When a pipe is present, display is afterPipe verbatim.
    const display = afterPipe !== undefined ? afterPipe.trim() : targetPart.trim()

    const slug = normalizeSlug(targetPart)
    if (!slug) continue

    out.push({
      slug,
      display: display.length > 0 ? display : targetPart.trim(),
      section: sectionPart?.trim() || null,
      raw: match[0] ?? '',
    })
  }
  return out
}
