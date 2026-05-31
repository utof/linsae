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
import type { Attachment, Note, SearchHit } from '../shared/types'
import type {
  AttachmentsListInputSchema,
  AttachToNoteInputSchema,
  BacklinksInputSchema,
  CaptureInputSchema,
  CommentsOfInputSchema,
  FetchOEmbedInputSchema,
  NoteIdSchema,
  NotesCreateInputSchema,
  NotesListInputSchema,
  NotesUpdateInputSchema,
  ResolveInputSchema,
  SearchRunInputSchema,
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
  },
  attachments: {
    list: (i: z.input<typeof AttachmentsListInputSchema>): Promise<Attachment[]> =>
      ipcRenderer.invoke('attachments:list', i),
    attachToNote: (i: z.input<typeof AttachToNoteInputSchema>): Promise<void> =>
      ipcRenderer.invoke('attachments:attachToNote', i),
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
}

contextBridge.exposeInMainWorld('api', api)

export type LinsaeApi = typeof api
