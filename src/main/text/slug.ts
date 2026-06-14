import { titleLine } from '../../shared/note-title'

/**
 * Normalizes a raw string into a canonical slug used for wikilink resolution.
 *
 * Why: Wikilinks must resolve case-insensitively and regardless of surrounding
 * whitespace or run-length of internal whitespace, so that `[[Foo Bar]]`,
 * `[[foo bar]]`, and `[[foo  bar]]` all resolve to the same note.
 * See spec §Wikilinks Resolution in docs/specs/v0.1-rolling-feed-and-search.md.
 *
 * @param raw - The raw string to normalize (e.g. a wikilink target or heading text).
 * @returns The normalized slug: trimmed, lowercased, and internal whitespace collapsed to a single space.
 */
export function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Derives a canonical slug from a note's markdown body.
 *
 * Why: A note's slug is its primary identity for wikilink resolution. The slug
 * is derived from the first meaningful line of the body: a heading (any level)
 * takes priority; otherwise the first non-empty line is used. This mirrors the
 * v21 wikilinks resolution rule described in spec §Wikilinks Resolution.
 * See docs/specs/v0.1-rolling-feed-and-search.md.
 *
 * @param body - The raw markdown content of a note.
 * @returns The normalized slug derived from the first meaningful line, or an empty
 *   string if the body has no non-empty lines.
 */
export function slugFromBody(body: string): string {
  return normalizeSlug(titleLine(body))
}
