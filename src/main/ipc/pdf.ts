import type { Database as DB } from 'better-sqlite3'
import { ipcMain } from 'electron'
import {
  PdfImportInputSchema,
  PdfListRecentInputSchema,
  PdfOpenInputSchema,
} from '../../shared/zod-schemas'
import { getPdfById, listRecentPdfs } from '../db/queries/pdf'
import { persistPdfImport } from '../media/persist-pdf'

/**
 * Thin-glue PDF IPC handlers (same posture as registerMediaIpc — handlers
 * contain zero logic so wrappers' colocated tests are the real coverage).
 * @see docs/specs/v0.6-pdf-slim-slice.md §3
 */
export function registerPdfIpc(db: DB, attachmentsDir: string): void {
  ipcMain.handle('pdf:import', async (_e, input) => {
    const i = PdfImportInputSchema.parse(input)
    const result = await persistPdfImport(db, { filePath: i.filePath, attachmentsDir })
    return {
      pdfId: result.pdfId,
      sha256: result.sha256,
      title: result.title,
      pageCount: result.pageCount,
    }
  })

  ipcMain.handle('pdf:open', (_e, input) => {
    const i = PdfOpenInputSchema.parse(input)
    const row = getPdfById(db, i.pdfId)
    if (!row || row.deleted_at !== null) return null
    // mediaUrl derived main-side from base_path (last 3 segments under /_media/).
    // NOTE: this duplicates the renderer's `mediaUrlFromPath` (src/renderer/src/lib/media-url.ts:20).
    // The contract is "last 3 path segments under /_media/"; a future refactor could move
    // the helper to src/shared/ to avoid the duplication.
    const mediaUrl = `/_media/${row.base_path.split(/[/\\]/).slice(-3).join('/')}`
    return {
      pdfId: row.id,
      sha256: row.sha256,
      title: row.title,
      pageCount: row.page_count,
      mediaUrl,
    }
  })

  ipcMain.handle('pdf:listRecent', (_e, input) => {
    const i = PdfListRecentInputSchema.parse(input)
    return listRecentPdfs(db, i.limit).map((r) => ({
      pdfId: r.id,
      title: r.title,
      pageCount: r.page_count,
      importedAt: r.imported_at,
    }))
  })
}
