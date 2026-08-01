// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'
import { getManySettings, setSetting } from '../../src/main/db/queries/settings'
import { PdfViewV1Schema, safeParseOr } from '../../src/shared/zod-schemas'

/** `SETTING_KEYS.pdfView`, inlined. Its map lives in `src/renderer/src/persistence/keys.ts:19`,
 *  which `tsconfig.node.json` does not include (TS6307) — a node-env test must not import the
 *  renderer. Keep the two in sync; the schema/round-trip below is what the key names. */
const PDF_VIEW_KEY = 'pdf.view.v1'

/**
 * `pdf.view.v1` end to end over a REAL sqlite file: the writer's payload shape →
 * `settings:set` (JSON-encoded TEXT) → a fresh process's boot read → the exact
 * `safeParseOr(PdfViewV1Schema, …, {})` the restore path uses
 * (`useSessionSnapshot.ts:35`).
 *
 * Why this needs real disk rather than a unit test of the schema: the value crosses
 * `JSON.stringify` / `JSON.parse` (`queries/settings.ts:19,27`), which is where a
 * non-finite number silently becomes `null`, and it crosses a process boundary,
 * which is where a v0.7 payload written by an older build meets a v0.8 reader.
 *
 * @see docs/plans/v0.8-multipage-pdf.md §Task 5.1 Step 5
 * @issue utof/linsae#154
 */

/** The boot read: exactly what `useSessionSnapshot` does for this one key. */
function restore(db: ReturnType<typeof openDb>) {
  const { [PDF_VIEW_KEY]: raw } = getManySettings(db, [PDF_VIEW_KEY])
  return safeParseOr(PdfViewV1Schema, raw, {})
}

let dir: string
let db: ReturnType<typeof openDb>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linsae-pdfview-'))
  db = openDb(join(dir, 'test.db'))
  runMigrations(db)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('pdf.view.v1 round-trip (real file db)', () => {
  it('restores {zoom, page, pageFraction} across a reopen', () => {
    const written = {
      'pdf-a': { zoom: 1.8, page: 7, pageFraction: 0.4177215189873418 },
      'pdf-b': { zoom: 1, page: 500, pageFraction: 0 },
    }
    setSetting(db, PDF_VIEW_KEY, written)

    // Reopen the file — a new process's boot, not a warm in-memory handle.
    db.close()
    db = openDb(join(dir, 'test.db'))

    // Deep equality, not toMatchObject: `pageFraction: 0` and a 16-significant-digit
    // fraction are exactly the values a lossy JSON hop would round or drop.
    expect(restore(db)).toEqual(written)
  })

  it('still parses a v0.7-shaped payload (no pageFraction, no page)', () => {
    // What is already on users' disks from v0.7: zoom-only, and zoom+page. Both must
    // survive the v0.8 schema untouched — `page`/`pageFraction` stayed `.optional()`.
    const v07 = { 'pdf-a': { zoom: 2.2 }, 'pdf-b': { zoom: 1, page: 3 } }
    setSetting(db, PDF_VIEW_KEY, v07)

    expect(restore(db)).toEqual(v07)
  })

  it('discards EVERY document when ONE entry is out of range — why the writer clamps', () => {
    // `PdfViewV1Schema` is a `z.record` and the read is `safeParseOr(…, {})`, so the
    // failure is whole-record, not per-key: a single `page: 0` costs the user every
    // other document's zoom and position too. This is the blast radius that makes
    // `clampPersistedAnchor` (PdfReader.tsx) load-bearing rather than decorative.
    setSetting(db, PDF_VIEW_KEY, {
      'pdf-a': { zoom: 1, page: 0 }, // `.positive()` — page numbers are 1-based
      'pdf-b': { zoom: 2.2, page: 4, pageFraction: 0.5 }, // perfectly valid, lost anyway
    })

    expect(restore(db)).toEqual({})
  })

  it('rejects a pageFraction outside 0..1 and a non-integer page', () => {
    for (const bad of [
      { 'pdf-a': { zoom: 1, page: 4, pageFraction: 1.0000001 } },
      { 'pdf-a': { zoom: 1, page: 4, pageFraction: -0.0001 } },
      { 'pdf-a': { zoom: 1, page: 4.5 } },
      // `Math.round` of a non-finite anchor: JSON.stringify(NaN) is `null` on disk.
      { 'pdf-a': { zoom: 1, page: Number.NaN, pageFraction: Number.NaN } },
    ]) {
      setSetting(db, PDF_VIEW_KEY, bad)
      expect(restore(db)).toEqual({})
    }
  })
})
