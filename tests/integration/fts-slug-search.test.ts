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
import { searchNotes } from '../../src/main/db/queries/search'
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
      db.prepare(`INSERT INTO notes_fts(notes_fts, rank) VALUES('integrity-check', 1)`).run(),
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
      db.prepare(`INSERT INTO notes_fts(notes_fts, rank) VALUES('integrity-check', 1)`).run(),
    ).not.toThrow()
  })

  it('searchNotes ranks title hit first + returns a display title', () => {
    saveNote(db, nd, { mode: 'create', body: '# Annotation\n\nx', type: 'claim' })
    saveNote(db, nd, { mode: 'create', body: '# Other\n\nannotation in body', type: 'claim' })
    const hits = searchNotes(db, { query: 'annotation', limit: 10 })
    expect(hits[0]!.note.slug).toBe('annotation')
    expect(hits[0]!.title).toBe('Annotation')
  })

  it('searchNotes prefix-matches a partial last token', () => {
    saveNote(db, nd, { mode: 'create', body: '# Annotation\n\nx', type: 'claim' })
    expect(searchNotes(db, { query: 'annot', limit: 10 }).map((h) => h.note.slug)).toContain(
      'annotation',
    )
  })

  it('searchNotes never throws on punctuation', () => {
    expect(searchNotes(db, { query: 'f(x) "', limit: 10 })).toEqual(expect.any(Array))
  })

  // Fix B — load-bearing slug-weight assertion (order-flipping fixture).
  // bm25's IDF term needs a corpus where the matched term is rare; with only
  // two documents the IDF collapses to ~0 and column weighting can't change
  // the order. So we seed 8 filler notes (none contain the term) to give IDF
  // teeth, then pit a slug-hit note (term ONCE, in its title) against a
  // body-only note that repeats the term 3× in a short body. Verified via a
  // standalone better-sqlite3 probe:
  //   plain    bm25(notes_fts)        => 'heavy' (body-only) ranks first
  //   weighted bm25(notes_fts,10,1)   => 'annotation' (title) ranks first
  // The 10× slug weight genuinely FLIPS the order — it is not incidental to
  // document length or term frequency. @see docs/specs/v0.5-command-search.md §1.1
  it('slug-weight flips ordering: title hit beats a term-heavy body-only hit', () => {
    for (let i = 0; i < 8; i++) {
      saveNote(db, nd, {
        mode: 'create',
        body: `# Fill ${i}\n\nunrelated filler text body content here words`,
        type: 'claim',
      })
    }
    // Slug note: term once, in the title; short body.
    saveNote(db, nd, { mode: 'create', body: '# Annotation\n\nshort', type: 'claim' })
    // Body-only note: short doc repeating the term 3× (high plain-bm25 term frequency).
    saveNote(db, nd, {
      mode: 'create',
      body: '# Heavy\n\nannotation annotation annotation',
      type: 'claim',
    })

    // Plain bm25 (no slug weight): the term-heavy body-only note ('heavy') wins.
    const plain = (
      db
        .prepare(
          `SELECT n.slug FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
           WHERE notes_fts MATCH ? AND n.deleted_at IS NULL
           ORDER BY bm25(notes_fts)`,
        )
        .all('annotation') as Array<{ slug: string }>
    ).map((r) => r.slug)
    expect(plain[0]).toBe('heavy') // without the weight, body-only outranks

    // searchNotes uses bm25(10.0, 1.0): the 10× slug weight flips it — title wins.
    const weighted = searchNotes(db, { query: 'annotation', limit: 10 }).map((h) => h.note.slug)
    expect(weighted[0]).toBe('annotation') // with the weight, title hit wins
  })
})
