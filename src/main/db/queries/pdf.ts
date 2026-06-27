/**
 * Query wrappers for the `pdf_documents` table (migration 0007).
 * Mirrors the pattern in ./video-sources.ts: each function takes an open DB,
 * uses inline prepared statements, and is side-effect-free beyond the DB call.
 * @see src/main/db/migrations/0007_pdf_documents.sql
 * @see docs/specs/v0.6-pdf-slim-slice.md §1
 */
import type { Database as DB } from 'better-sqlite3'

/** A fully hydrated row from `pdf_documents`. */
export interface PdfDocumentRow {
  id: string
  sha256: string
  base_path: string
  title: string | null
  page_count: number | null
  imported_at: number
  deleted_at: number | null
}

/** Input for `insertPdfDocument`. `imported_at` defaults to `Date.now()` when omitted. */
export interface InsertPdfInput {
  id: string
  sha256: string
  base_path: string
  title: string | null
  page_count: number | null
  imported_at?: number
}

/**
 * Insert a pdf_documents row. If a live row with the same sha256 already exists
 * (dedup), return that existing row instead of inserting — the partial-unique
 * index `idx_pdf_documents_sha_live` enforces one live row per content hash.
 * Why: re-importing the same PDF must not duplicate the file or the row.
 * @see docs/specs/v0.6-pdf-slim-slice.md §1 (migration 0007)
 */
export function insertPdfDocument(db: DB, input: InsertPdfInput): PdfDocumentRow {
  const existing = getPdfBySha(db, input.sha256)
  if (existing) return existing
  const now = input.imported_at ?? Date.now()
  db.prepare(
    `INSERT INTO pdf_documents (id, sha256, base_path, title, page_count, imported_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.id, input.sha256, input.base_path, input.title, input.page_count, now)
  return getPdfById(db, input.id)!
}

/**
 * Fetch a row by primary key regardless of soft-delete state.
 * Why: intentionally does NOT filter `deleted_at` — `insertPdfDocument` calls
 * this to return the row it just inserted (which is always live), and Task 4's
 * `pdf:open` handler does its own `deleted_at` guard before surfacing the row
 * to the renderer.
 */
export function getPdfById(db: DB, id: string): PdfDocumentRow | null {
  return (
    (db.prepare('SELECT * FROM pdf_documents WHERE id = ?').get(id) as
      | PdfDocumentRow
      | undefined) ?? null
  )
}

/**
 * Fetch a live (non-deleted) row by content hash, or null if absent.
 * Why: filters `deleted_at IS NULL` so that re-importing soft-deleted content
 * inserts a fresh live row rather than returning the tombstone — no unique-index
 * violation occurs because the partial index covers only live rows.
 */
export function getPdfBySha(db: DB, sha256: string): PdfDocumentRow | null {
  return (
    (db
      .prepare('SELECT * FROM pdf_documents WHERE sha256 = ? AND deleted_at IS NULL')
      .get(sha256) as PdfDocumentRow | undefined) ?? null
  )
}

/**
 * Return up to `limit` live rows, most-recently-imported first.
 * Why: recent-first order matches the recency feed in the renderer; soft-deleted
 * rows are excluded so tombstoned PDFs do not appear in the list.
 */
export function listRecentPdfs(db: DB, limit: number): PdfDocumentRow[] {
  return db
    .prepare(
      'SELECT * FROM pdf_documents WHERE deleted_at IS NULL ORDER BY imported_at DESC LIMIT ?',
    )
    .all(limit) as PdfDocumentRow[]
}

/**
 * Tombstone a pdf_documents row by setting `deleted_at` to the current epoch ms.
 * Why: soft-delete preserves the file on disk and the DB row for audit/recovery;
 * hard deletion is out of scope for v0.6.
 */
export function softDeletePdf(db: DB, id: string): void {
  db.prepare('UPDATE pdf_documents SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
}
