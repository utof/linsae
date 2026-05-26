/**
 * Wikilink resolver: maps a raw `[[target]]` string to its destination Note
 * (or null when no live note matches — the dangling-link case).
 *
 * Resolution order, per spec §Resolution rule (lines 212-219):
 *   1. Normalize `targetRaw` via `normalizeSlug` (trim + lowercase + collapse
 *      internal whitespace).
 *   2. Exact-match on `notes.slug` for a non-deleted row → return.
 *   3. Else exact-match on `note_aliases.alias` → if any non-deleted match,
 *      return the most recently created one.
 *   4. Else null → caller renders as a dangling link (orange).
 *
 * The "exactly one alias match" and "more than one — most recent wins" branches
 * of the spec collapse into a single `ORDER BY n.created_at DESC LIMIT 1` query
 * since the most-recent-of-one is itself.
 *
 * All queries filter `n.deleted_at IS NULL` so soft-deleted notes can never
 * resolve — they show as dangling and a re-created note can pick up inbound
 * links cleanly.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Resolution rule
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Case-sensitivity
 * @see src/main/text/slug.ts normalizeSlug
 * @see src/main/db/migrations/0001_init.sql (notes, note_aliases)
 */

import type Database from 'better-sqlite3'
import type { Note } from '../../../shared/types'
import { normalizeSlug } from '../../text/slug'

type DB = Database.Database

/**
 * Resolves a raw wikilink target string to its destination Note, or null.
 *
 * Why most-recent-wins on alias collisions: aliases are user-authored
 * frontmatter and may legitimately overlap (rare). Picking the newest
 * non-deleted match keeps the click action deterministic without surfacing
 * a picker UX at v0.1 — see spec §Resolution rule step 5. A v0.2
 * disambiguator dialog is deferred.
 *
 * Empty / whitespace-only `targetRaw` short-circuits to null so `[[ ]]` or
 * `[[]]` never accidentally matches a note with an empty slug.
 *
 * @param db - Open better-sqlite3 Database.
 * @param targetRaw - The raw `[[target]]` text exactly as authored.
 * @returns The resolved live Note, or `null` for dangling.
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Resolution rule
 */
export function resolveWikilink(db: DB, targetRaw: string): Note | null {
  const slug = normalizeSlug(targetRaw)
  if (!slug) return null

  const bySlug = db
    .prepare(
      `SELECT id, slug, body, type, created_at, updated_at, deleted_at
       FROM notes
       WHERE slug = ? AND deleted_at IS NULL`,
    )
    .get(slug) as Note | undefined
  if (bySlug) return bySlug

  const byAlias = db
    .prepare(
      `SELECT n.id, n.slug, n.body, n.type, n.created_at, n.updated_at, n.deleted_at
       FROM note_aliases a
       JOIN notes n ON n.id = a.note_id
       WHERE a.alias = ?
         AND n.deleted_at IS NULL
       ORDER BY n.created_at DESC
       LIMIT 1`,
    )
    .get(slug) as Note | undefined
  return byAlias ?? null
}
