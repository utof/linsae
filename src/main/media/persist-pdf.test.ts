// @vitest-environment node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../db/client'
import { runMigrations } from '../db/migrate'
import { extractPdfMetadata } from './extract-pdf-metadata'
import { persistPdfImport } from './persist-pdf'

// Stub metadata extraction to avoid pdf.js in this unit test
vi.mock('./extract-pdf-metadata', () => ({
  extractPdfMetadata: vi.fn().mockResolvedValue({ title: 'Stubbed', pageCount: 7 }),
}))

let db: ReturnType<typeof openDb>
let attachmentsDir: string

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'linsae-persist-pdf-'))
  db = openDb(join(dir, 'test.db'))
  runMigrations(db)
  attachmentsDir = join(dir, 'attachments')
  // mkdtempSync only creates `dir`; create the attachments subdir so the test
  // can write the source PDF into it before persistPdfImport copies it out.
  mkdirSync(attachmentsDir, { recursive: true })
})

describe('persistPdfImport', () => {
  it('writes the file content-addressed and inserts a row', async () => {
    const src = join(attachmentsDir, 'src.pdf')
    writeFileSync(src, Buffer.from('%PDF-1.4 stub'))
    const result = await persistPdfImport(db, { filePath: src, attachmentsDir })
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(result.basePath)).toBe(true)
    expect(readFileSync(result.basePath)).toEqual(Buffer.from('%PDF-1.4 stub'))
  })

  it('dedups: re-import of identical bytes returns the same row, does not rewrite', async () => {
    const src = join(attachmentsDir, 'dup.pdf')
    writeFileSync(src, Buffer.from('same bytes'))
    const first = await persistPdfImport(db, { filePath: src, attachmentsDir })
    const second = await persistPdfImport(db, { filePath: src, attachmentsDir })
    expect(second.pdfId).toBe(first.pdfId)
    expect(second.basePath).toBe(first.basePath)
  })

  it('falls back to filename stem when /Title is absent (spec §3)', async () => {
    // Override the module-level mock for this one call — simulates a PDF with no /Title
    vi.mocked(extractPdfMetadata).mockResolvedValueOnce({ title: null, pageCount: 3 })
    const src = join(attachmentsDir, 'mydoc.pdf')
    writeFileSync(src, Buffer.from('%PDF-1.4 stub'))
    const result = await persistPdfImport(db, { filePath: src, attachmentsDir })
    expect(result.title).toBe('mydoc')
  })
})
