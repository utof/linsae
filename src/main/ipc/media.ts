/**
 * IPC handlers for the v0.2 media surface: screenshot capture, oEmbed metadata,
 * attachment listing/attaching, and video-source cache upsert/get. Thin glue —
 * each handler Zod-parses then delegates to a tested helper (same posture as
 * src/main/ipc/notes.ts).
 *
 * @see docs/specs/v0.2-youtube-annotation.md §IPC contracts
 */
import type Database from 'better-sqlite3'
import { BrowserWindow, ipcMain, screen } from 'electron'
import {
  AttachmentRemoveInputSchema,
  AttachmentsListInputSchema,
  AttachToNoteInputSchema,
  CaptureInputSchema,
  FetchOEmbedInputSchema,
  SaveOverlayInputSchema,
  VideoSourcesGetInputSchema,
  VideoSourcesUpsertInputSchema,
} from '../../shared/zod-schemas'
import {
  attachToNote,
  listAttachmentsByTitleLike,
  listAttachmentsByVideo,
  listAttachmentsForNote,
  listOrphanAttachments,
} from '../db/queries/attachments'
import { getVideoSource, upsertVideoSource } from '../db/queries/video-sources'
import { fetchOEmbed } from '../media/oembed'
import { persistCapture } from '../media/persist-capture'
import { persistOverlay, removeAttachment } from '../media/persist-overlay'
import { clampRect } from '../media/rect-clamp'

type DB = Database.Database

/**
 * Wires the youtube / attachments / videoSources IPC channels.
 *
 * Why: Called once from `registerAllIpc` after DB and attachmentsDir are
 * resolved. Thin Zod-parse + delegate pattern mirrors registerNotesIpc.
 *
 * @param db - Open better-sqlite3 Database.
 * @param attachmentsDir - Absolute path for captured PNG storage.
 * @see docs/specs/v0.2-youtube-annotation.md §IPC contracts
 */
export function registerMediaIpc(db: DB, attachmentsDir: string): void {
  ipcMain.handle('youtube:capture', async (e, input) => {
    const i = CaptureInputSchema.parse(input)
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('capture: no window for sender')
    const view = win.getContentBounds()
    const rect = clampRect(i.rect, { width: view.width, height: view.height })
    // clampRect can collapse a fully off-viewport iframe to a 0-area rect; Electron's
    // capturePage RESOLVES (not rejects) on 0×0, writing a degenerate empty PNG + junk
    // row (verified via scripts/capture-smoke.mjs). Reject early instead. (GH #34)
    if (rect.width === 0 || rect.height === 0) {
      throw new Error('capture: rect is empty after clamping (frame off-screen?)')
    }
    const image = await win.webContents.capturePage(rect)
    const size = image.getSize() // physical px (rect × scaleFactor)
    const devicePixelRatio = screen.getDisplayMatching(win.getBounds()).scaleFactor
    return persistCapture(db, {
      png: image.toPNG(),
      attachmentsDir,
      videoId: i.videoId,
      t: i.t,
      width: size.width,
      height: size.height,
      devicePixelRatio,
    })
  })

  ipcMain.handle('youtube:fetchOEmbed', (_e, input) => {
    const i = FetchOEmbedInputSchema.parse(input)
    return fetchOEmbed(i.videoId)
  })

  ipcMain.handle('attachments:list', (_e, input) => {
    const i = AttachmentsListInputSchema.parse(input)
    if (i.orphans) return listOrphanAttachments(db)
    if (i.noteId) return listAttachmentsForNote(db, i.noteId)
    if (i.videoId) return listAttachmentsByVideo(db, i.videoId)
    if (i.titleLike) return listAttachmentsByTitleLike(db, i.titleLike)
    return []
  })

  ipcMain.handle('attachments:attachToNote', (_e, input) => {
    const i = AttachToNoteInputSchema.parse(input)
    attachToNote(db, { id: i.attachmentId, noteId: i.noteId })
  })

  ipcMain.handle('videoSources:upsert', (_e, input) => {
    const i = VideoSourcesUpsertInputSchema.parse(input)
    upsertVideoSource(db, {
      video_id: i.videoId,
      source_kind: i.sourceKind,
      ...(i.title !== undefined ? { title: i.title } : {}),
      ...(i.channel !== undefined ? { channel: i.channel } : {}),
      ...(i.thumbnailUrl !== undefined ? { thumbnail_url: i.thumbnailUrl } : {}),
      ...(i.durationSec !== undefined ? { duration_sec: i.durationSec } : {}),
    })
  })

  ipcMain.handle('videoSources:get', (_e, input) => {
    const i = VideoSourcesGetInputSchema.parse(input)
    const v = getVideoSource(db, i.videoId)
    return v
      ? {
          title: v.title,
          channel: v.channel,
          thumbnailUrl: v.thumbnail_url,
          durationSec: v.duration_sec,
        }
      : null
  })

  /**
   * Write or clear the SVG annotation overlay for a screenshot attachment.
   *
   * Delegates to `persistOverlay` (the tested unit) which throws on unknown/
   * soft-deleted ids before touching disk — no orphaned `.svg` can be created.
   *
   * @see src/main/media/persist-overlay.ts
   * @see docs/specs/v0.2.5-screenshot-annotation.md §IPC contract (saveOverlay)
   */
  ipcMain.handle('youtube:saveOverlay', (_e, input) => {
    const i = SaveOverlayInputSchema.parse(input)
    return persistOverlay(db, { id: i.attachmentId, svg: i.svg })
  })

  /**
   * Soft-delete an orphan attachment and remove its sidecar (if any).
   *
   * Used by the capture-time "Discard" prompt. PNG bytes on disk are not
   * touched — file reclamation is a separate future concern
   * (v0.2-youtube-annotation.md §Risks).
   *
   * @see src/main/db/queries/attachments.ts (softDeleteAttachment)
   * @see docs/specs/v0.2.5-screenshot-annotation.md §IPC contract (attachments.remove)
   */
  ipcMain.handle('attachments:remove', (_e, input) => {
    const i = AttachmentRemoveInputSchema.parse(input)
    removeAttachment(db, { id: i.id })
  })
}
