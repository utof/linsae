/**
 * note_access log + recency/frecency ranking + the lean uncapped title feed
 * (spec §3 §7). frecencyScore is pure (zoxide model) so it is unit-tested in
 * isolation; the ranking happens in JS over a bounded candidate set (see the
 * plan's "Frecency SQL-vs-JS" note) — the step-function buckets + aging do not
 * express cleanly or testably in SQL CASE.
 * @see https://github.com/ajeetdsouza/zoxide/wiki/Algorithm (frecency buckets)
 * @see docs/specs/v0.5-command-search.md §7
 */
import type Database from 'better-sqlite3'
import { deriveTitle } from '../../../shared/note-title'
import type { NoteTitleRow } from '../../../shared/types'

type DB = Database.Database

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/**
 * Pure zoxide-style frecency: frequency × recency-bucket multiplier.
 * Buckets: <1h ×4, <1d ×2, <1w ×0.5, else ×0.25 (age = now − lastAccessed).
 * @see https://github.com/ajeetdsouza/zoxide/wiki/Algorithm
 */
export function frecencyScore(frequency: number, lastAccessed: number, now: number): number {
  const age = now - lastAccessed
  const mult = age < HOUR ? 4 : age < DAY ? 2 : age < WEEK ? 0.5 : 0.25
  return frequency * mult
}

/** Bump (or create) the note's access row: last_accessed_at = now, frequency += 1.
 * @see docs/specs/v0.5-command-search.md §7 */
export function recordAccess(db: DB, noteId: string, now: number = Date.now()): void {
  db.prepare(
    `INSERT INTO note_access (note_id, last_accessed_at, frequency) VALUES (?, ?, 1)
     ON CONFLICT(note_id) DO UPDATE SET last_accessed_at = excluded.last_accessed_at,
       frequency = frequency + 1`,
  ).run(noteId, now)
}

/**
 * Recent/frecent notes for the ⌘O / ⌘P empty-state. `recent` = last_accessed DESC;
 * `frecent` = frecencyScore DESC. Candidate set = all note_access rows joined to
 * live notes (so we have body→title), unioned with the newest live notes lacking
 * an access row (so a brand-new never-opened note can still appear) — bounded to a
 * few × limit before the JS sort.
 * @see docs/specs/v0.5-command-search.md §3
 */
export function recentNotes(
  db: DB,
  opts: { mode: 'recent' | 'frecent'; limit: number },
  now: number = Date.now(),
): NoteTitleRow[] {
  const cap = Math.max(opts.limit * 5, 50)
  // Candidate cap is recency-ordered for BOTH modes: in `frecent` a very-high-
  // frequency but old note can fall outside the top-`cap` recent rows before the
  // JS frecency sort — a deliberate, plan-sanctioned approximation (plan:53).
  const accessed = db
    .prepare(
      `SELECT n.id, n.body, n.slug, a.last_accessed_at AS last, a.frequency AS freq
       FROM note_access a JOIN notes n ON n.id = a.note_id
       WHERE n.deleted_at IS NULL
       ORDER BY a.last_accessed_at DESC LIMIT ?`,
    )
    .all(cap) as Array<{ id: string; body: string; slug: string; last: number; freq: number }>

  const ranked = accessed
    .map((r) => ({
      id: r.id,
      title: deriveTitle(r.body) || r.slug,
      key: opts.mode === 'recent' ? r.last : frecencyScore(r.freq, r.last, now),
    }))
    .sort((a, b) => b.key - a.key)
    .slice(0, opts.limit)

  if (ranked.length >= opts.limit) return ranked.map(({ id, title }) => ({ id, title }))

  // Backfill with newest never-accessed notes so the empty-state is never sparse.
  const have = new Set(ranked.map((r) => r.id))
  const fresh = db
    .prepare(
      `SELECT id, body, slug FROM notes WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`,
    )
    .all(opts.limit * 2) as Array<{ id: string; body: string; slug: string }>
  const out: NoteTitleRow[] = ranked.map(({ id, title }) => ({ id, title }))
  for (const f of fresh) {
    if (out.length >= opts.limit) break
    if (!have.has(f.id)) out.push({ id: f.id, title: deriveTitle(f.body) || f.slug })
  }
  return out
}

/** ALL live notes as {id, title} — the UNCAPPED switcher feed (the #130 cap fix).
 * @see docs/specs/v0.5-command-search.md §3 */
export function listTitles(db: DB): NoteTitleRow[] {
  const rows = db
    .prepare(`SELECT id, body, slug FROM notes WHERE deleted_at IS NULL ORDER BY created_at DESC`)
    .all() as Array<{ id: string; body: string; slug: string }>
  return rows.map((r) => ({ id: r.id, title: deriveTitle(r.body) || r.slug }))
}
