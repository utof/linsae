// @vitest-environment node

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../client'
import { runMigrations } from '../migrate'
import { getPdfById, getPdfBySha, insertPdfDocument, listRecentPdfs, softDeletePdf } from './pdf'

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'linsae-pdf-'))
  const db = openDb(join(dir, 'test.db'))
  runMigrations(db)
  return { db, dir }
}

describe('pdf_documents queries', () => {
  let db: ReturnType<typeof openDb>
  beforeEach(() => {
    const fresh = freshDb()
    db = fresh.db
  })

  it('inserts and fetches by id', () => {
    const row = insertPdfDocument(db, {
      id: '01HTEST',
      sha256: 'abc123',
      base_path: '/tmp/2026/06/abc123.pdf',
      title: 'A Paper',
      page_count: 42,
    })
    expect(row.id).toBe('01HTEST')
    const got = getPdfById(db, '01HTEST')
    expect(got?.title).toBe('A Paper')
    expect(got?.page_count).toBe(42)
  })

  it('dedups by sha256 (returns existing row)', () => {
    insertPdfDocument(db, {
      id: 'id1',
      sha256: 'dup',
      base_path: '/p.pdf',
      title: 'A',
      page_count: 1,
    })
    const again = insertPdfDocument(db, {
      id: 'id2',
      sha256: 'dup',
      base_path: '/p.pdf',
      title: 'A',
      page_count: 1,
    })
    expect(again.id).toBe('id1')
  })

  it('getPdfBySha returns null for unknown sha', () => {
    expect(getPdfBySha(db, 'nope')).toBeNull()
  })

  it('listRecentPdfs orders by imported_at desc, excludes soft-deleted', () => {
    // Three live rows at distinct imported_at values; one will be soft-deleted.
    // The assertion pins both ordering (3000 > 2000 > 1000) and exclusion.
    insertPdfDocument(db, {
      id: 'early',
      sha256: 's1',
      base_path: '/1.pdf',
      title: 'Early',
      page_count: 1,
      imported_at: 1000,
    })
    insertPdfDocument(db, {
      id: 'mid',
      sha256: 's2',
      base_path: '/2.pdf',
      title: 'Mid',
      page_count: 2,
      imported_at: 2000,
    })
    insertPdfDocument(db, {
      id: 'latest',
      sha256: 's3',
      base_path: '/3.pdf',
      title: 'Latest',
      page_count: 3,
      imported_at: 3000,
    })
    softDeletePdf(db, 'early')
    const recent = listRecentPdfs(db, 10)
    expect(recent.map((r) => r.id)).toEqual(['latest', 'mid'])
  })
})
