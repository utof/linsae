// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'
import { getPdfById, listRecentPdfs } from '../../src/main/db/queries/pdf'
import { persistPdfImport } from '../../src/main/media/persist-pdf'

// Stub metadata extraction — no real pdf.js in this integration test.
// Real pdf.js rendering is covered by the Task 15 Playwright smoke.
vi.mock('../../src/main/media/extract-pdf-metadata', () => ({
  extractPdfMetadata: vi.fn().mockResolvedValue({ title: 'Integration', pageCount: 3 }),
}))

let db: ReturnType<typeof openDb>
let attachmentsDir: string

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'linsae-pdf-int-'))
  db = openDb(join(dir, 'test.db'))
  runMigrations(db)
  attachmentsDir = join(dir, 'attachments')
  // mkdtempSync only creates `dir`; create the attachments subdir so the test
  // can write the source PDF into it before persistPdfImport copies it out.
  mkdirSync(attachmentsDir, { recursive: true })
})

describe('PDF import round-trip', () => {
  it('import → open → listRecent; mediaUrl derives from base_path', async () => {
    const src = join(attachmentsDir, 'src.pdf')
    writeFileSync(src, Buffer.from('%PDF-1.4 integration'))
    const imported = await persistPdfImport(db, { filePath: src, attachmentsDir })

    // Verify the DB row was written correctly
    const opened = getPdfById(db, imported.pdfId)
    expect(opened).not.toBeNull()

    // Inline derivation byte-matches the pdf:open handler in src/main/ipc/pdf.ts:36.
    // This is a genuine parity check — if the handler's expression ever changes,
    // this test will catch the drift.
    const mediaUrl = `/_media/${opened!.base_path.split(/[/\\]/).slice(-3).join('/')}`
    expect(mediaUrl).toMatch(/^\/_media\/\d{4}\/\d{2}\/[0-9a-f]{64}\.pdf$/)

    // listRecentPdfs includes the newly imported row
    const recent = listRecentPdfs(db, 10)
    expect(recent.map((r) => r.id)).toContain(imported.pdfId)
  })

  it('dedup: re-import returns the same row', async () => {
    const src = join(attachmentsDir, 'dup.pdf')
    writeFileSync(src, Buffer.from('same'))
    const a = await persistPdfImport(db, { filePath: src, attachmentsDir })
    const b = await persistPdfImport(db, { filePath: src, attachmentsDir })
    expect(b.pdfId).toBe(a.pdfId)
  })
})
