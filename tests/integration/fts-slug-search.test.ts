// @vitest-environment node
/**
 * Integration tests for FTS slug-weighting + prefix index (v0.5 migration 0004).
 *
 * Verifies:
 * 1. Slug (title-word) hits rank above body-only hits via bm25 column weighting.
 * 2. Prefix index allows `"annot"*` to find "annotation".
 * 3. Delete trigger passes old.slug correctly — no orphaned index rows.
 * 4. Update trigger re-indexes both old (remove) and new (insert) slug+body.
 *
 * Uses real disk (mkdtempSync) + real SQLite file, mirroring the posture of
 * canvas-edges.test.ts.
 *
 * @see docs/specs/v0.5-command-search.md §1.1 (slug-weighted bm25)
 * @see src/main/db/migrations/0004_fts_slug_prefix.sql
 * @see https://www.sqlite.org/fts5.html#external_content_tables
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'
import { NotesDir } from '../../src/main/files/notes-dir'
import { saveNote } from '../../src/main/save-note'

let dir: string
let db: ReturnType<typeof openDb>
let nd: NotesDir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linsae-fts-'))
  const notesDir = join(dir, 'notes')
  db = openDb(join(dir, 'test.db'))
  runMigrations(db)
  nd = new NotesDir(notesDir)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Raw FTS probe mirroring search.ts: MATCH on slug+body, ordered by slug-weighted bm25.
 * Column weights: slug=10.0, body=1.0 — slug hits float to the top.
 */
function fts(q: string): string[] {
  return (
    db
      .prepare(
        `SELECT n.slug FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ? AND n.deleted_at IS NULL
         ORDER BY bm25(notes_fts, 10.0, 1.0)`,
      )
      .all(q) as Array<{ slug: string }>
  ).map((r) => r.slug)
}

describe('FTS slug-weighting + prefix', () => {
  it('ranks a slug (title-word) hit above a body-only hit', () => {
    saveNote(db, nd, { mode: 'create', body: '# Annotation\n\nmisc', type: 'claim' })
    saveNote(db, nd, {
      mode: 'create',
      body: '# Misc note\n\nthis mentions annotation here',
      type: 'claim',
    })
    const ranked = fts('annotation')
    expect(ranked[0]).toBe('annotation') // title hit first (slug 10× weight)
  })

  it('prefix-matches: "annot"* finds "annotation" via the prefix index', () => {
    saveNote(db, nd, { mode: 'create', body: '# Annotation\n\nbody', type: 'claim' })
    expect(fts('"annot"*')).toContain('annotation')
  })

  it('delete leaves NO orphaned notes_fts rows (old.slug matches what was indexed)', () => {
    const n = saveNote(db, nd, {
      mode: 'create',
      body: '# Orphan check\n\nfindme',
      type: 'claim',
    })
    expect(fts('findme')).toContain('orphan check')
    db.prepare('DELETE FROM notes WHERE id = ?').run(n.id) // fires notes_ad
    expect(fts('findme')).toEqual([]) // index row gone, not orphaned
    expect(() =>
      db.prepare(`INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')`).run(),
    ).not.toThrow()
  })

  it('update re-indexes slug+body (old slug no longer matches; new body does)', () => {
    const n = saveNote(db, nd, { mode: 'create', body: '# First\n\nalpha', type: 'claim' })
    saveNote(db, nd, {
      mode: 'update',
      id: n.id,
      body: '# First\n\nbeta',
      type: 'claim',
    }) // slug frozen = 'first'
    expect(fts('alpha')).toEqual([])
    expect(fts('beta')).toContain('first')
    expect(() =>
      db.prepare(`INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')`).run(),
    ).not.toThrow()
  })
})
