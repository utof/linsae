/**
 * Preload contextBridge: exposes the typed `window.api` surface to the
 * renderer.
 *
 * Why: contextIsolation is on in production (enforced by Task 21's
 * `secureWebPreferences`), so the renderer cannot access Electron internals
 * directly. Every IPC channel is funnelled through a single `api` object
 * whose shape mirrors the handler registrations in `src/main/ipc/notes.ts`
 * and `src/main/ipc/system.ts`.
 *
 * Argument types use `z.input<typeof Schema>` (not `z.output<...>`) because
 * the renderer sends pre-validation data — defaults applied by Zod (e.g.
 * `NotesListInputSchema.limit.default(100)`) should be optional on the
 * renderer side and only materialise after the main-process `.parse(input)`.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §IPC channels at v0.1
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 20 Step 4
 * @see src/main/ipc/notes.ts
 * @see src/main/ipc/system.ts
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { z } from 'zod'
import type { CanvasCamera, CanvasEdge, CanvasLayoutRow, RecentEntry } from '../shared/canvas'
import type { Attachment, Note, NoteTitleRow, SearchHit } from '../shared/types'
import type {
  AttachmentRemoveInputSchema,
  AttachmentsListInputSchema,
  AttachToNoteInputSchema,
  BacklinksInputSchema,
  CanvasCreateEdgeInputSchema,
  CanvasCreateNoteAtInputSchema,
  CanvasDeleteEdgeInputSchema,
  CanvasEdgesInputSchema,
  CanvasGetStateInputSchema,
  CanvasListLayoutsInputSchema,
  CanvasMoveNotesInputSchema,
  CanvasNoteIdsInputSchema,
  CanvasPlaceNoteInputSchema,
  CanvasRecentInputSchema,
  CanvasRestoreLayoutsInputSchema,
  CanvasSetStateInputSchema,
  CanvasShelveNoteInputSchema,
  CaptureInputSchema,
  ChooseFileInputSchema,
  CommentsOfInputSchema,
  FetchOEmbedInputSchema,
  FindSourceByPdfIdInputSchema,
  NoteIdSchema,
  NotesCreateInputSchema,
  NotesListInputSchema,
  NotesRecentInputSchema,
  NotesRecordAccessInputSchema,
  NotesUpdateInputSchema,
  PdfImportInputSchema,
  PdfListRecentInputSchema,
  PdfOpenInputSchema,
  ResolveInputSchema,
  SaveOverlayInputSchema,
  SearchRunInputSchema,
  SettingsGetInputSchema,
  SettingsSetInputSchema,
  VideoSourcesGetInputSchema,
  VideoSourcesUpsertInputSchema,
} from '../shared/zod-schemas'

const api = {
  notes: {
    list: (i: z.input<typeof NotesListInputSchema>): Promise<Note[]> =>
      ipcRenderer.invoke('notes:list', i),
    get: (i: z.input<typeof NoteIdSchema>): Promise<Note | null> =>
      ipcRenderer.invoke('notes:get', i),
    create: (i: z.input<typeof NotesCreateInputSchema>): Promise<Note> =>
      ipcRenderer.invoke('notes:create', i),
    update: (i: z.input<typeof NotesUpdateInputSchema>): Promise<Note> =>
      ipcRenderer.invoke('notes:update', i),
    delete: (i: z.input<typeof NoteIdSchema>): Promise<Note> =>
      ipcRenderer.invoke('notes:delete', i),
    listTitles: (): Promise<NoteTitleRow[]> => ipcRenderer.invoke('notes:listTitles'),
    recent: (i: z.input<typeof NotesRecentInputSchema>): Promise<NoteTitleRow[]> =>
      ipcRenderer.invoke('notes:recent', i),
    recordAccess: (i: z.input<typeof NotesRecordAccessInputSchema>): Promise<{ ok: true }> =>
      ipcRenderer.invoke('notes:recordAccess', i),
    findSourceByPdfId: (i: z.input<typeof FindSourceByPdfIdInputSchema>): Promise<Note | null> =>
      ipcRenderer.invoke('notes:findSourceByPdfId', i),
  },
  pdf: {
    import: (
      i: z.input<typeof PdfImportInputSchema>,
    ): Promise<{ pdfId: string; sha256: string; title: string | null; pageCount: number | null }> =>
      ipcRenderer.invoke('pdf:import', i),
    open: (
      i: z.input<typeof PdfOpenInputSchema>,
    ): Promise<{
      pdfId: string
      sha256: string
      title: string | null
      pageCount: number | null
      mediaUrl: string
    } | null> => ipcRenderer.invoke('pdf:open', i),
    listRecent: (
      i: z.input<typeof PdfListRecentInputSchema>,
    ): Promise<
      { pdfId: string; title: string | null; pageCount: number | null; importedAt: number }[]
    > => ipcRenderer.invoke('pdf:listRecent', i),
  },
  search: {
    run: (i: z.input<typeof SearchRunInputSchema>): Promise<SearchHit[]> =>
      ipcRenderer.invoke('search:run', i),
  },
  links: {
    backlinks: (i: z.input<typeof BacklinksInputSchema>): Promise<Note[]> =>
      ipcRenderer.invoke('links:backlinks', i),
    resolve: (i: z.input<typeof ResolveInputSchema>): Promise<Note | null> =>
      ipcRenderer.invoke('links:resolve', i),
    commentsOf: (
      i: z.input<typeof CommentsOfInputSchema>,
    ): Promise<Array<{ note: Note; attachment: Attachment | null }>> =>
      ipcRenderer.invoke('links:commentsOf', i),
  },
  canvas: {
    listLayouts: (i: z.input<typeof CanvasListLayoutsInputSchema>): Promise<CanvasLayoutRow[]> =>
      ipcRenderer.invoke('canvas:listLayouts', i),
    edges: (i: z.input<typeof CanvasEdgesInputSchema>): Promise<CanvasEdge[]> =>
      ipcRenderer.invoke('canvas:edges', i),
    shelveNote: (i: z.input<typeof CanvasShelveNoteInputSchema>): Promise<void> =>
      ipcRenderer.invoke('canvas:shelveNote', i),
    placeNote: (i: z.input<typeof CanvasPlaceNoteInputSchema>): Promise<void> =>
      ipcRenderer.invoke('canvas:placeNote', i),
    moveNotes: (i: z.input<typeof CanvasMoveNotesInputSchema>): Promise<void> =>
      ipcRenderer.invoke('canvas:moveNotes', i),
    unplaceNotes: (i: z.input<typeof CanvasNoteIdsInputSchema>): Promise<void> =>
      ipcRenderer.invoke('canvas:unplaceNotes', i),
    restoreLayouts: (i: z.input<typeof CanvasRestoreLayoutsInputSchema>): Promise<void> =>
      ipcRenderer.invoke('canvas:restoreLayouts', i),
    removeNotes: (i: z.input<typeof CanvasNoteIdsInputSchema>): Promise<void> =>
      ipcRenderer.invoke('canvas:removeNotes', i),
    getState: (i: z.input<typeof CanvasGetStateInputSchema>): Promise<CanvasCamera> =>
      ipcRenderer.invoke('canvas:getState', i),
    setState: (i: z.input<typeof CanvasSetStateInputSchema>): Promise<void> =>
      ipcRenderer.invoke('canvas:setState', i),
    recentOnCanvas: (i: z.input<typeof CanvasRecentInputSchema>): Promise<RecentEntry[]> =>
      ipcRenderer.invoke('canvas:recentOnCanvas', i),
    createNoteAt: (i: z.input<typeof CanvasCreateNoteAtInputSchema>): Promise<Note> =>
      ipcRenderer.invoke('canvas:createNoteAt', i),
    createEdge: (i: z.input<typeof CanvasCreateEdgeInputSchema>): Promise<void> =>
      ipcRenderer.invoke('canvas:createEdge', i),
    deleteEdge: (i: z.input<typeof CanvasDeleteEdgeInputSchema>): Promise<void> =>
      ipcRenderer.invoke('canvas:deleteEdge', i),
  },
  youtube: {
    capture: (
      i: z.input<typeof CaptureInputSchema>,
    ): Promise<{
      id: string
      path: string
      sha256: string
      width: number
      height: number
      devicePixelRatio: number
    }> => ipcRenderer.invoke('youtube:capture', i),
    fetchOEmbed: (
      i: z.input<typeof FetchOEmbedInputSchema>,
    ): Promise<{
      title: string
      author_name: string
      author_url: string
      thumbnail_url: string
    } | null> => ipcRenderer.invoke('youtube:fetchOEmbed', i),
    authStatus: (): Promise<{ signedIn: boolean }> => ipcRenderer.invoke('youtube:authStatus'),
    signIn: (): Promise<{ ok: true }> => ipcRenderer.invoke('youtube:signIn'),
    signOut: (): Promise<{ ok: true }> => ipcRenderer.invoke('youtube:signOut'),
    importCookies: (): Promise<
      { canceled: true } | { canceled: false; ok: number; fail: number }
    > => ipcRenderer.invoke('youtube:importCookies'),
    /**
     * Write or clear the SVG annotation sidecar for a screenshot attachment.
     * `svg: null` clears the overlay (deletes the sidecar, nulls overlay_path).
     * Throws if the attachment id is unknown or soft-deleted.
     * @see docs/specs/v0.2.5-screenshot-annotation.md §IPC contract (saveOverlay)
     */
    saveOverlay: (
      i: z.input<typeof SaveOverlayInputSchema>,
    ): Promise<{ overlayPath: string | null }> => ipcRenderer.invoke('youtube:saveOverlay', i),
  },
  attachments: {
    list: (i: z.input<typeof AttachmentsListInputSchema>): Promise<Attachment[]> =>
      ipcRenderer.invoke('attachments:list', i),
    attachToNote: (i: z.input<typeof AttachToNoteInputSchema>): Promise<void> =>
      ipcRenderer.invoke('attachments:attachToNote', i),
    /**
     * Soft-delete an orphan attachment and remove its SVG sidecar (if any).
     * PNG bytes on disk are preserved; reclamation is a separate future concern.
     * @see docs/specs/v0.2.5-screenshot-annotation.md §IPC contract (attachments.remove)
     */
    remove: (i: z.input<typeof AttachmentRemoveInputSchema>): Promise<void> =>
      ipcRenderer.invoke('attachments:remove', i),
  },
  videoSources: {
    upsert: (i: z.input<typeof VideoSourcesUpsertInputSchema>): Promise<void> =>
      ipcRenderer.invoke('videoSources:upsert', i),
    get: (
      i: z.input<typeof VideoSourcesGetInputSchema>,
    ): Promise<{
      title: string | null
      channel: string | null
      thumbnailUrl: string | null
      durationSec: number | null
    } | null> => ipcRenderer.invoke('videoSources:get', i),
  },
  system: {
    revealNotesFolder: (): Promise<{ ok: true }> => ipcRenderer.invoke('system:revealNotesFolder'),
    openLogsFolder: (): Promise<{ ok: true }> => ipcRenderer.invoke('system:openLogsFolder'),
    getReconcileSkipped: (): Promise<number> => ipcRenderer.invoke('system:getReconcileSkipped'),
    chooseFile: (i: z.input<typeof ChooseFileInputSchema>): Promise<{ filePaths: string[] }> =>
      ipcRenderer.invoke('system:chooseFile', i),
    // Window controls for the frameless BrowserWindow — invoked from the
    // custom WindowFrame's min/max/close buttons (see src/renderer/src/topbar/
    // WindowFrame.tsx). Main resolves the target window via
    // BrowserWindow.fromWebContents so no window-id payload is needed.
    window: {
      minimize: (): Promise<{ ok: true }> => ipcRenderer.invoke('system:windowMinimize'),
      toggleMaximize: (): Promise<{ ok: true }> =>
        ipcRenderer.invoke('system:windowToggleMaximize'),
      close: (): Promise<{ ok: true }> => ipcRenderer.invoke('system:windowClose'),
    },
  },
  settings: {
    get: (i: z.input<typeof SettingsGetInputSchema>): Promise<{ value: unknown }> =>
      ipcRenderer.invoke('settings:get', i),
    getMany: (keys: string[]): Promise<{ values: Record<string, unknown> }> =>
      ipcRenderer.invoke('settings:getMany', { keys }),
    set: (i: z.input<typeof SettingsSetInputSchema>): Promise<{ ok: true }> =>
      ipcRenderer.invoke('settings:set', i),
  },
  // Harness flag (spec §3 / §17): true ONLY when the Playwright perf harness
  // launched the app with LINSAE_HARNESS=1 (scripts/canvas-perf-harness.mjs).
  // In normal prod use the env var is unset → false → the renderer never
  // attaches window.__canvasHarness. Read at preload load (process.env is
  // available in the preload context; the renderer itself is isolated).
  // @see docs/specs/v0.4-canvas-mvp.md §3 §17
  isHarness: process.env.LINSAE_HARNESS === '1',
}

contextBridge.exposeInMainWorld('api', api)

export type LinsaeApi = typeof api
