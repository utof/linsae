/**
 * Startup reconciler — the recovery mechanism that makes the SQLite index
 * agree with the on-disk markdown files, treating disk as the source of truth.
 *
 * Algorithm (one DB transaction):
 *  1. Enumerate every `*.md` file under the notes directory.
 *  2. Snapshot every `notes.id` already in the DB.
 *  3. For each on-disk file:
 *     - Malformed frontmatter → skip + count (NEVER delete).
 *     - File present, DB row absent → INSERT + insert links from body.
 *     - File present, DB row present but body hash differs → UPDATE + replace links.
 *  4. For each DB row whose id is NOT on disk → set `deleted_at = now()`.
 *  5. If `logsDir` was provided AND there were skips, append one TSV line per
 *     skipped file (`<iso_stamp>\t<id>\t<error>`) to `<logsDir>/reconcile.log`.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Reconciler algorithm
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Storage architecture
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 19
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { ReconcileReport } from '../../shared/types'
import type { NotesDir } from '../files/notes-dir'
import { extractWikilinks } from '../text/wikilinks'
import { replaceLinksForNote } from './queries/links'

type DB = Database.Database

/**
 * Returns the sha256 hex digest of `body`.
 *
 * Why sha256 (not stat/mtime): mtime can lie after file copies, restore-from-
 * backup, or git checkouts; content hash is the only reliable change signal.
 * Spec §Performance posture suggests a stat() pre-filter for scale, but at
 * v0.1's target (≤ a few thousand notes) pure hashing is plenty fast and
 * avoids the stat/hash skew bugs that a two-pass design introduces. See plan
 * §Task 19 step 3 for the explicit single-pass decision.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Performance posture
 */
function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

/**
 * Walk the notes directory and the SQLite DB, then make the DB match disk.
 * Returns a {@link ReconcileReport} with per-bucket counts; never throws on
 * malformed files (they are counted as `skipped`).
 *
 * All mutations run inside a single `db.transaction(...)` so a crash mid-scan
 * either rolls back fully or commits fully — the next startup retries cleanly
 * with no half-state. Inner calls to {@link replaceLinksForNote} open their
 * own savepoint transactions; better-sqlite3 nests these via SQLite SAVEPOINTs,
 * matching the pattern in {@link import('../save-note.ts').saveNote}.
 *
 * Why call `replaceLinksForNote` rather than inline DELETE+INSERT: keeps the
 * link-write contract in ONE place (DRY). If link semantics ever gain a new
 * column (`weight`, `created_at`, ...) the reconciler picks it up for free.
 *
 * Why optional `logsDir`: in tests we don't want disk I/O for the log file;
 * in production the main process passes `userData/logs` so the v0.1 top-of-feed
 * banner ("<n> notes had unreadable frontmatter") can link to a real file.
 *
 * @param db - Open better-sqlite3 Database.
 * @param nd - {@link NotesDir} pointed at the user's notes directory.
 * @param logsDir - Optional absolute path to write `reconcile.log` into; if
 *   omitted, skipped files are still counted but not logged to disk.
 * @returns Per-bucket counts: `scanned`, `inserted`, `updated`, `deleted`, `skipped`.
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Reconciler algorithm
 */
export function reconcile(db: DB, nd: NotesDir, logsDir?: string): ReconcileReport {
  const onDisk = new Set(nd.listNoteIds())
  const report: ReconcileReport = {
    scanned: onDisk.size,
    inserted: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
  }
  const skippedFiles: Array<{ id: string; error: string }> = []

  db.transaction(() => {
    const existing = new Map<string, { body: string }>()
    for (const row of db.prepare('SELECT id, body FROM notes').all() as {
      id: string
      body: string
    }[]) {
      existing.set(row.id, { body: row.body })
    }

    const insertStmt = db.prepare(
      `INSERT INTO notes (id, slug, body, type, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const updateStmt = db.prepare(
      `UPDATE notes SET body = ?, slug = ?, type = ?, updated_at = ?, deleted_at = ?
       WHERE id = ?`,
    )
    const tombstoneStmt = db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?')

    for (const id of onDisk) {
      const r = nd.readNote(id)
      if (!r.ok) {
        report.skipped++
        skippedFiles.push({ id, error: r.error })
        continue
      }
      const fm = r.frontmatter
      // Why `?? null`: NoteFrontmatter.deleted_at is `number | undefined`, but
      // better-sqlite3's binding accepts `null` (not `undefined`); coerce.
      const deletedAt: number | null = fm.deleted_at ?? null
      const prev = existing.get(id)
      if (!prev) {
        insertStmt.run(id, fm.slug, r.body, fm.type, fm.created_at, fm.updated_at, deletedAt)
        replaceLinksForNote(db, id, extractWikilinks(r.body))
        report.inserted++
      } else if (hashBody(prev.body) !== hashBody(r.body)) {
        updateStmt.run(r.body, fm.slug, fm.type, fm.updated_at, deletedAt, id)
        replaceLinksForNote(db, id, extractWikilinks(r.body))
        report.updated++
      }
    }

    const now = Date.now()
    for (const [id] of existing) {
      if (!onDisk.has(id)) {
        tombstoneStmt.run(now, id)
        report.deleted++
      }
    }
  })()

  if (logsDir && skippedFiles.length > 0) {
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })
    const stamp = new Date().toISOString()
    const lines = `${skippedFiles.map((s) => `${stamp}\t${s.id}\t${s.error}`).join('\n')}\n`
    appendFileSync(join(logsDir, 'reconcile.log'), lines)
  }

  return report
}
