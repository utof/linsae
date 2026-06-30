// @vitest-environment node
/**
 * Integration test: PDF source note → excerpt child `comment-on` round-trip.
 *
 * Proves:
 *   1. `commentsForNote(db, sourceSlug)` returns exactly the excerpt child.
 *   2. `getSourceNoteByPdfId(db, pdfId)` returns the source note;
 *      exactly one source row per pdf_id exists after a single create call
 *      (idempotency invariant enforced at import time per the function's docstring).
 *
 * Uses real disk (mkdtempSync) + real SQLite file, mirroring the harness in
 * `tests/integration/file-db-roundtrip.test.ts`.
 *
 * @see src/main/save-note.ts
 * @see src/main/db/queries/links.ts (commentsForNote, setCommentOnEdge)
 * @see src/main/db/queries/notes.ts (getSourceNoteByPdfId)
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'
import { commentsForNote } from '../../src/main/db/queries/links'
import { getSourceNoteByPdfId } from '../../src/main/db/queries/notes'
import { NotesDir } from '../../src/main/files/notes-dir'
import { saveNote } from '../../src/main/save-note'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linsae-pdf-thread-'))
  dbPath = join(dir, 'db.sqlite')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('PDF excerpt → comment-on child round-trip', () => {
  it('source note + excerpt child linked by comment-on edge; getSourceNoteByPdfId idempotent', () => {
    const nd = new NotesDir(join(dir, 'notes'))
    const db = openDb(dbPath)
    runMigrations(db)

    const PDF_ID = 'pdf-abc'

    // 1. Create the PDF source note (document-level anchor — no excerpt fields).
    const sourceNote = saveNote(db, nd, {
      mode: 'create',
      type: 'source',
      source_kind: 'pdf',
      source_locator: { media: 'pdf', pdf_id: PDF_ID },
      body: '',
    })

    // 2. Create the excerpt child with a full PDF locator + comment-on edge.
    const excerptNote = saveNote(db, nd, {
      mode: 'create',
      type: 'claim',
      source_kind: 'pdf',
      source_locator: {
        media: 'pdf',
        pdf_id: PDF_ID,
        page: 2,
        rect: [10, 20, 100, 30],
        quote: 'Integration test quote',
        prefix: 'before the quote',
        suffix: 'after the quote',
      },
      commentOn: sourceNote.slug,
      body: 'This is the excerpt body.',
    })

    // 3. commentsForNote returns exactly one child, and it is the excerpt.
    const comments = commentsForNote(db, sourceNote.slug)
    expect(comments).toHaveLength(1)
    expect(comments[0]!.note.id).toBe(excerptNote.id)
    expect(comments[0]!.note.slug).toBe(excerptNote.slug)

    // 4. getSourceNoteByPdfId returns the source note (non-null, correct id).
    const found = getSourceNoteByPdfId(db, PDF_ID)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(sourceNote.id)

    // 5. Idempotency is an APP-LEVEL invariant (no UNIQUE on pdf_id): the import
    //    path is resolve-then-create-if-null (App.tsx onOpenPdf / excerpt bridge →
    //    getSourceNoteByPdfId → create only when null). Replicate that guard and run
    //    it twice — the second call must short-circuit, leaving ONE row. NB: calling
    //    saveNote directly twice WOULD create two rows — an empty body means
    //    slug === uuid, so the duplicate-slug pre-check (save-note.ts:160) is skipped
    //    and each create inserts a fresh id; the dedup lives in the resolve guard, not the DB.
    const resolveOrCreate = () => {
      if (!getSourceNoteByPdfId(db, PDF_ID)) {
        saveNote(db, nd, {
          mode: 'create',
          type: 'source',
          source_kind: 'pdf',
          source_locator: { media: 'pdf', pdf_id: PDF_ID },
          body: '',
        })
      }
    }
    resolveOrCreate()
    resolveOrCreate()

    const { c } = db
      .prepare(
        `SELECT COUNT(*) AS c FROM notes
          WHERE deleted_at IS NULL AND type = 'source'
            AND json_extract(source_locator, '$.pdf_id') = ?`,
      )
      .get(PDF_ID) as { c: number }
    expect(c).toBe(1)

    db.close()
  })
})
