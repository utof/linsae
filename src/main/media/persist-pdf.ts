import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Database as DB } from 'better-sqlite3'
import { uuidv7 } from 'uuidv7'
import { getPdfBySha, insertPdfDocument } from '../db/queries/pdf'
import { atomicWriteFileSync } from './atomic-write'
import { extractPdfMetadata } from './extract-pdf-metadata'
import { sha256Hex } from './sha256'

export interface PersistPdfImportInput {
  filePath: string
  attachmentsDir: string
}

export interface PersistPdfImportResult {
  pdfId: string
  sha256: string
  basePath: string
  title: string | null
  pageCount: number | null
}

/**
 * Import a PDF: read bytes, sha256, dedup by content hash, atomic-write to
 * `<attachmentsDir>/<yyyy>/<mm>/<sha>.pdf` if absent, insert a `pdf_documents`
 * row (or return the existing one on dedup). Extracts /Title + numPages via
 * main-side pdf.js.
 *
 * Mirrors persist-capture.ts (dedup at the file/sha256 layer; distinct rows
 * for distinct content). Returns paths/metadata, never Buffers, across the
 * IPC boundary.
 * @see docs/specs/v0.6-pdf-slim-slice.md §3 (pdf:import)
 */
export async function persistPdfImport(
  db: DB,
  input: PersistPdfImportInput,
): Promise<PersistPdfImportResult> {
  const bytes = readFileSync(input.filePath)
  const sha256 = sha256Hex(bytes)
  const existing = getPdfBySha(db, sha256)
  if (existing) {
    return {
      pdfId: existing.id,
      sha256: existing.sha256,
      basePath: existing.base_path,
      title: existing.title,
      pageCount: existing.page_count,
    }
  }
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const basePath = join(input.attachmentsDir, yyyy, mm, `${sha256}.pdf`)
  if (!existsSync(basePath)) atomicWriteFileSync(basePath, bytes)
  // Extraction failure is non-fatal — a corrupt/unparseable PDF still imports
  // with null metadata and will surface an error at open/render time (the
  // renderer pdf.js is the real validation gate).
  const meta = await extractPdfMetadata(bytes)
  const row = insertPdfDocument(db, {
    id: uuidv7(),
    sha256,
    base_path: basePath,
    // Why: spec §3 — when /Title is absent, fall back to the filename stem so
    // the document has a human-readable label rather than null.
    title: meta.title ?? basename(input.filePath, '.pdf'),
    page_count: meta.pageCount,
  })
  return {
    pdfId: row.id,
    sha256: row.sha256,
    basePath: row.base_path,
    title: row.title,
    pageCount: row.page_count,
  }
}
