/**
 * Renderer-side typed wrapper over `window.api` (the contextBridge surface
 * exposed by the preload script). Repackages the IPC bridge with ergonomic
 * positional arguments and call-site defaults so component code stays terse.
 *
 * Why a wrapper: the preload bridge takes a single object payload per call
 * (mirroring Zod input schemas validated in main); UI components prefer
 * positional args (`api.notes.get(id)` over `window.api.notes.get({ id })`)
 * and per-method defaults (e.g. `type = 'claim'` for `notes.create`).
 *
 * Why route through `window.api`: contextIsolation is on, so the renderer has
 * no direct access to `ipcRenderer`; every channel call flows through the
 * `contextBridge.exposeInMainWorld('api', ...)` surface defined in preload.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §IPC channels at v0.1
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 22
 * @see src/preload/index.ts
 */

import type { CanvasCamera, CanvasEdge, CanvasLayoutRow, RecentEntry } from '../../../shared/canvas'
import type {
  Attachment,
  Note,
  NoteTitleRow,
  SearchHit,
  SourceLocator,
} from '../../../shared/types'
import type { AccessKind } from '../../../shared/zod-schemas'

/** Opaque canvas/arrangement key shared by most canvas IPC calls (spec §2). */
type CanvasKey = { canvasId: string; arrangementId: string }

/**
 * Ergonomic typed facade over `window.api`. Use this from components / hooks
 * rather than touching `window.api` directly.
 *
 * Why: keeps positional-args + defaults centralised so the IPC payload shape
 * can evolve (extra optional fields) without touching call-sites.
 *
 * @see src/preload/index.ts
 */
export const api = {
  notes: {
    /**
     * Paginated feed of non-deleted notes, newest-first.
     * Why optional `input`: lets components call `api.notes.list()` without
     * payload; defaults (e.g. `limit: 500`) are applied by the main-process
     * Zod parse on `NotesListInputSchema`.
     *
     * `excludeThreadChildren`: pass `true` from the FEED query only (#165);
     * canvas pickers (EdgeTargetPicker, Picker, DevBootMeter) omit it so they
     * can reach every note including comment-on children placed on the canvas.
     * @see src/main/ipc/notes.ts
     * @issue utof/linsae#165
     */
    list: (input?: {
      limit?: number
      before?: number
      excludeThreadChildren?: boolean
    }): Promise<Note[]> => window.api.notes.list(input ?? {}),
    /**
     * Fetch a single note by id (returns `null` if not found / soft-deleted).
     * @see src/main/ipc/notes.ts
     */
    get: (id: string): Promise<Note | null> => window.api.notes.get({ id }),
    /**
     * Create a new note. Why `type` defaults to `'claim'`: claim is the
     * default authoring mode in the composer (spec §Composer); explicit
     * `'question'` is only used in question-mode.
     *
     * `source` carries the optional media-annotation fields (YouTube/PDF — PDF
     * added in v0.6, YouTube since v0.2): `source_kind` / `source_locator` link
     * the note to a media position; `commentOn` sets the parent video slug for
     * thread-child notes. Undefined fields are omitted (not passed as
     * `undefined`) to satisfy `exactOptionalPropertyTypes` and the Zod
     * `optional()` contract.
     *
     * @see src/main/ipc/notes.ts
     * @see docs/specs/v0.2-youtube-annotation.md §Data model
     * @see docs/specs/v0.6-pdf-slim-slice.md
     */
    create: (
      body: string,
      type: Note['type'] = 'claim',
      source?: {
        source_kind?: 'youtube' | 'pdf'
        source_locator?: SourceLocator
        commentOn?: string
      },
    ): Promise<Note> =>
      window.api.notes.create({
        body,
        type,
        ...(source?.source_kind ? { source_kind: source.source_kind } : {}),
        ...(source?.source_locator ? { source_locator: source.source_locator } : {}),
        ...(source?.commentOn ? { commentOn: source.commentOn } : {}),
      }),
    /**
     * Update an existing note's body / type. Why no default for `type`:
     * updates always carry an explicit type — the composer round-trips it.
     *
     * `source` carries optional media-annotation fields (YouTube/PDF):
     * `source_kind` / `source_locator` (no `commentOn` — threads don't
     * move parents post-creation). Undefined fields are omitted to satisfy
     * `exactOptionalPropertyTypes`.
     *
     * @see src/main/ipc/notes.ts
     * @see docs/specs/v0.2-youtube-annotation.md §Data model
     * @see docs/specs/v0.6-pdf-slim-slice.md
     */
    update: (
      id: string,
      body: string,
      type: Note['type'],
      source?: { source_kind?: 'youtube' | 'pdf'; source_locator?: SourceLocator },
    ): Promise<Note> =>
      window.api.notes.update({
        id,
        body,
        type,
        ...(source?.source_kind ? { source_kind: source.source_kind } : {}),
        ...(source?.source_locator ? { source_locator: source.source_locator } : {}),
      }),
    /**
     * Soft-delete a note (sets `deleted_at`; file is removed from disk).
     * Returns the soft-deleted row for optimistic UI updates.
     * @see src/main/ipc/notes.ts
     */
    delete: (id: string): Promise<Note> => window.api.notes.delete({ id }),
    /** ALL live note titles, uncapped — the ⌘O switcher feed (#130 cap fix).
     * @see docs/specs/v0.5-command-search.md §3 */
    listTitles: (): Promise<NoteTitleRow[]> => window.api.notes.listTitles(),
    /** Recent/frecent notes for the ⌘O/⌘P empty-state.
     * @see docs/specs/v0.5-command-search.md §3 */
    recent: (mode: 'recent' | 'frecent', limit = 15): Promise<NoteTitleRow[]> =>
      window.api.notes.recent({ mode, limit }),
    /** Bump a note's access row (open/edit/jump). Fire-and-forget at call sites.
     * @see docs/specs/v0.5-command-search.md §7 */
    recordAccess: (noteId: string, kind: AccessKind): Promise<{ ok: true }> =>
      window.api.notes.recordAccess({ noteId, kind }),
    /**
     * Resolve the live source note whose source_locator.pdf_id matches pdfId, or null.
     * Why: import idempotency (Task 3.3) + excerpt commentOn target slug (Task 4.1).
     * The DB function is `getSourceNoteByPdfId`; the renderer-facing name is
     * `findSourceByPdfId` — two distinct names by design (spec §Name consistency).
     * @see docs/specs/v0.6.4-notes-as-threads.md §Data model
     */
    findSourceByPdfId: (pdfId: string): Promise<Note | null> =>
      window.api.notes.findSourceByPdfId({ pdfId }),
  },
  /**
   * PDF IPC facade: content-addressed import, open-by-id (with derived
   * `mediaUrl`), and a recent-first list. Mirrors the preload `pdf` namespace;
   * repackages object payloads into positional args.
   * @see src/preload/index.ts (pdf namespace)
   * @see docs/specs/v0.6-pdf-slim-slice.md §3
   */
  pdf: {
    /**
     * Import a PDF by absolute path: content-hash, dedup, store, extract
     * /Title + page count. Returns the row id + metadata (never bytes).
     * @see src/main/ipc/pdf.ts
     */
    import: (
      filePath: string,
    ): Promise<{ pdfId: string; sha256: string; title: string | null; pageCount: number | null }> =>
      window.api.pdf.import({ filePath }),
    /**
     * Open a stored PDF by id — returns its metadata + the relative `/_media/`
     * URL the renderer loads, or `null` if missing / soft-deleted.
     * @see src/main/ipc/pdf.ts
     */
    open: (
      pdfId: string,
    ): Promise<{
      pdfId: string
      sha256: string
      title: string | null
      pageCount: number | null
      mediaUrl: string
    } | null> => window.api.pdf.open({ pdfId }),
    /**
     * List recently-imported PDFs, newest-first. `limit` defaults to 20.
     * @see src/main/ipc/pdf.ts
     */
    listRecent: (
      limit = 20,
    ): Promise<
      { pdfId: string; title: string | null; pageCount: number | null; importedAt: number }[]
    > => window.api.pdf.listRecent({ limit }),
  },
  search: {
    /**
     * FTS5 search with snippet highlighting. Why `limit = 50`: matches the
     * Command Palette's default visible-result budget (spec §Search).
     * @see src/main/ipc/notes.ts
     */
    run: (query: string, limit = 50): Promise<SearchHit[]> =>
      window.api.search.run({ query, limit }),
  },
  links: {
    /**
     * Notes whose body wikilinks back to the given note id.
     * @see src/main/ipc/notes.ts
     */
    backlinks: (noteId: string): Promise<Note[]> => window.api.links.backlinks({ noteId }),
    /**
     * Alias-aware wikilink resolver — maps a raw `[[target]]` slug to its
     * destination note (or `null` for dangling). Why server-side: the rule
     * is slug → alias → most-recent-wins (spec §Resolution rule), which
     * needs the DB. The renderer-side `slugSet` only covers step 1 for the
     * dangling-class render pass; click navigation must use this resolver.
     * @see docs/specs/v0.1-rolling-feed-and-search.md §Resolution rule
     * @see src/main/ipc/notes.ts
     */
    resolve: (slug: string): Promise<Note | null> => window.api.links.resolve({ slug }),
    /**
     * Comment-notes linked to a video-note via `comment-on` edges, with their
     * latest live attachment. Returns oldest-first so callers can feed directly
     * into `sortForMode` without pre-sorting.
     * @issue utof/linsae#36
     * @see src/main/ipc/notes.ts
     */
    commentsOf: (noteId: string): Promise<Array<{ note: Note; attachment: Attachment | null }>> =>
      window.api.links.commentsOf({ noteId }),
  },
  /**
   * Canvas IPC facade: layout rows, resolved edges, placement mutations, and
   * the per-canvas persisted camera. Mirrors the preload `canvas` namespace
   * 1:1 — object payloads pass through unchanged (no positional repackaging),
   * because every call already carries an opaque `{ canvasId, arrangementId }`
   * key (spec §2 — no implicit defaults outside `src/shared/canvas.ts`).
   * @see src/preload/index.ts (canvas namespace)
   * @see docs/specs/v0.4-canvas-mvp.md §2
   */
  canvas: {
    /** node_layouts rows for a canvas+arrangement (both-null x/y = shelved). */
    listLayouts: (i: CanvasKey): Promise<CanvasLayoutRow[]> => window.api.canvas.listLayouts(i),
    /** Resolved links between placed notes, for read-only edge rendering. */
    edges: (i: CanvasKey): Promise<CanvasEdge[]> => window.api.canvas.edges(i),
    /** Move a placed note back to the shelf (nulls x/y, keeps the row). */
    shelveNote: (i: CanvasKey & { noteId: string }): Promise<void> =>
      window.api.canvas.shelveNote(i),
    /** Place a note at world coords (x/y), inserting or un-shelving its row. */
    placeNote: (i: CanvasKey & { noteId: string; x: number; y: number }): Promise<void> =>
      window.api.canvas.placeNote(i),
    /** Batch-move already-placed notes to new world coords (drag commit). */
    moveNotes: (
      i: CanvasKey & { moves: Array<{ noteId: string; x: number; y: number }> },
    ): Promise<void> => window.api.canvas.moveNotes(i),
    /** Shelf a batch of notes (x/y → null) without deleting their rows. */
    unplaceNotes: (i: CanvasKey & { noteIds: string[] }): Promise<void> =>
      window.api.canvas.unplaceNotes(i),
    /** Re-insert previously-removed layout rows (undo of removeNotes). */
    restoreLayouts: (
      i: CanvasKey & {
        rows: Array<{
          noteId: string
          x: number | null
          y: number | null
          createdAt: number
          placedAt: number | null
        }>
      },
    ): Promise<void> => window.api.canvas.restoreLayouts(i),
    /** Hard-remove layout rows from a canvas (note itself is untouched). */
    removeNotes: (i: CanvasKey & { noteIds: string[] }): Promise<void> =>
      window.api.canvas.removeNotes(i),
    /** The persisted camera for a canvas (defaults to {0,0,1} server-side). */
    getState: (i: { canvasId: string }): Promise<CanvasCamera> => window.api.canvas.getState(i),
    /** Persist the camera for a canvas (debounced + flushed by useCanvasCamera). */
    setState: (i: {
      canvasId: string
      camera_x: number
      camera_y: number
      zoom: number
    }): Promise<void> => window.api.canvas.setState(i),
    /** Recently edited/placed/created notes for the canvas recent popover. */
    recentOnCanvas: (i: CanvasKey & { limit?: number }): Promise<RecentEntry[]> =>
      window.api.canvas.recentOnCanvas(i),
    /** Create a note AND place it at (x,y) in one transaction (single timestamp). */
    createNoteAt: (
      i: CanvasKey & { body: string; type?: Note['type']; x: number; y: number },
    ): Promise<Note> => window.api.canvas.createNoteAt(i),
    /**
     * Draw a typed edge from one note to another. Resolves toNoteId→slug server-side.
     * Rejects reserved edge_types and self-edges (spec §2).
     * @see docs/specs/v0.4.1-canvas-edges.md §2
     */
    createEdge: (i: {
      canvasId: string
      arrangementId: string
      fromNoteId: string
      toNoteId: string
      edgeType: string
    }): Promise<void> => window.api.canvas.createEdge(i),
    /**
     * Delete the exact drawn-edge PK row. toSlug comes from canvas:edges (Task 1).
     * Rejects reserved edge_types (read-only on canvas — spec §2 decision 6).
     * @see docs/specs/v0.4.1-canvas-edges.md §2
     */
    deleteEdge: (i: {
      canvasId: string
      arrangementId: string
      fromNoteId: string
      toSlug: string
      edgeType: string
    }): Promise<void> => window.api.canvas.deleteEdge(i),
  },
  /**
   * YouTube IPC facade: screenshot capture and oEmbed metadata fetch.
   * @see src/preload/index.ts (youtube namespace)
   * @see docs/specs/v0.2-youtube-annotation.md §Capture flow
   */
  youtube: {
    /**
     * Capture a screenshot rectangle of the current window at the given
     * video position. Returns an orphan attachment row.
     * Why positional `rect` + `videoId` + `t`: mirrors the call sites in
     * the capture flow where all three are known at the point of invocation.
     * @see src/main/ipc/youtube.ts
     */
    capture: (
      rect: { x: number; y: number; width: number; height: number },
      videoId: string,
      t: number,
    ): Promise<{
      id: string
      path: string
      sha256: string
      width: number
      height: number
      devicePixelRatio: number
    }> => window.api.youtube.capture({ rect, videoId, t }),
    /**
     * Fetch oEmbed metadata for a YouTube video (title, channel, thumbnail).
     * Returns null if the video is not accessible / not found.
     * @see src/main/ipc/youtube.ts
     */
    fetchOEmbed: (
      videoId: string,
    ): Promise<{
      title: string
      author_name: string
      author_url: string
      thumbnail_url: string
    } | null> => window.api.youtube.fetchOEmbed({ videoId }),
    /**
     * Whether the player partition holds a Google web-session (i.e. signed in).
     * @see src/main/ipc/youtube-auth.ts
     */
    authStatus: (): Promise<{ signedIn: boolean }> => window.api.youtube.authStatus(),
    /**
     * Open the dedicated ServiceLogin sign-in window (ADR 0017). Resolves once the window is
     * opened, not when sign-in completes — re-query `authStatus` after the user signs in.
     * @see src/main/yt-login.ts
     */
    signIn: (): Promise<{ ok: true }> => window.api.youtube.signIn(),
    /**
     * Sign out: clear the partition's cookies (keeps other storage like the volume pref).
     * @see src/main/ipc/youtube-auth.ts
     */
    signOut: (): Promise<{ ok: true }> => window.api.youtube.signOut(),
    /**
     * Pick a Netscape cookies.txt via a native dialog and replace the partition session from
     * it. Resolves `{canceled:true}` if the user dismissed the picker.
     * @see src/main/ipc/youtube-auth.ts
     */
    importCookies: (): Promise<
      { canceled: true } | { canceled: false; ok: number; fail: number }
    > => window.api.youtube.importCookies(),
    /**
     * Write or clear the SVG annotation sidecar for a screenshot attachment.
     * Pass `svg: null` to clear (deletes the sidecar file, nulls overlay_path).
     * Throws if the attachment id is unknown or soft-deleted.
     * @see docs/specs/v0.2.5-screenshot-annotation.md §IPC contract (saveOverlay)
     */
    saveOverlay: (
      attachmentId: string,
      svg: string | null,
    ): Promise<{ overlayPath: string | null }> =>
      window.api.youtube.saveOverlay({ attachmentId, svg }),
  },
  /**
   * Attachments IPC facade: list and associate screenshot/clip rows.
   * @see src/preload/index.ts (attachments namespace)
   * @see docs/specs/v0.2-youtube-annotation.md §Attachments
   */
  attachments: {
    /**
     * List attachment rows with optional filters (orphans / by video / by
     * title / by note). All filters are optional and combinable.
     * @see src/main/ipc/attachments.ts
     */
    list: (filter: {
      orphans?: boolean
      videoId?: string
      titleLike?: string
      noteId?: string
    }): Promise<Attachment[]> => window.api.attachments.list(filter),
    /**
     * Associate an orphan attachment with a note row.
     * @see src/main/ipc/attachments.ts
     */
    attachToNote: (attachmentId: string, noteId: string): Promise<void> =>
      window.api.attachments.attachToNote({ attachmentId, noteId }),
    /**
     * Soft-delete an orphan attachment and remove its SVG sidecar (if any).
     * Used by the capture-time "Discard" prompt (Esc → Discard). PNG bytes
     * on disk are preserved; file reclamation is a future concern.
     * @see docs/specs/v0.2.5-screenshot-annotation.md §IPC contract (attachments.remove)
     */
    remove: (id: string): Promise<void> => window.api.attachments.remove({ id }),
  },
  /**
   * VideoSources IPC facade: upsert and retrieve cached video metadata.
   * @see src/preload/index.ts (videoSources namespace)
   * @see docs/specs/v0.2-youtube-annotation.md §Add a video
   */
  videoSources: {
    /**
     * Upsert a video_sources row. `sourceKind` is always 'youtube' for v0.2.
     * Optional oEmbed-derived fields are COALESCEd server-side so a
     * metadata-less re-upsert never wipes a cached title.
     * @see src/main/ipc/videoSources.ts
     */
    upsert: (
      videoId: string,
      opts?: { title?: string; channel?: string; thumbnailUrl?: string; durationSec?: number },
    ): Promise<void> =>
      window.api.videoSources.upsert({ videoId, sourceKind: 'youtube', ...(opts ?? {}) }),
    /**
     * Fetch cached title/channel/thumbnail/duration for a video, or null if not yet upserted.
     * @see src/main/ipc/videoSources.ts
     */
    get: (
      videoId: string,
    ): Promise<{
      title: string | null
      channel: string | null
      thumbnailUrl: string | null
      durationSec: number | null
    } | null> => window.api.videoSources.get({ videoId }),
  },
  settings: {
    /** Read a JSON-decoded setting value (null if unset). @see src/main/ipc/notes.ts */
    get: (key: string): Promise<{ value: unknown }> => window.api.settings.get({ key }),
    /** Batch-read many settings in one round-trip (`{ key: value | null }`) — the
     * boot session-restore read. @see docs/specs/v0.7-session-persistence.md */
    getMany: (keys: string[]): Promise<{ values: Record<string, unknown> }> =>
      window.api.settings.getMany(keys),
    /** Upsert a setting (value JSON-encoded server-side). */
    set: (key: string, value: unknown): Promise<{ ok: true }> =>
      window.api.settings.set({ key, value }),
  },
  system: {
    /**
     * Open the notes directory in the OS file manager.
     * @see src/main/ipc/system.ts
     */
    revealNotesFolder: (): Promise<{ ok: true }> => window.api.system.revealNotesFolder(),
    /**
     * Open the application logs directory in the OS file manager.
     * @see src/main/ipc/system.ts
     */
    openLogsFolder: (): Promise<{ ok: true }> => window.api.system.openLogsFolder(),
    /**
     * Count of malformed-frontmatter notes the last reconcile run skipped —
     * drives the spec §Banners "reconcile-skip banner" UX.
     * @see src/main/ipc/system.ts
     */
    getReconcileSkipped: (): Promise<number> => window.api.system.getReconcileSkipped(),
    /**
     * Open a native file picker. Pass dialog `filters` (e.g. `[{ name: 'PDF',
     * extensions: ['pdf'] }]`); they are repackaged into the `{ filters }`
     * payload the preload bridge expects. Returns the chosen absolute paths
     * (empty array if the user cancelled).
     * @see src/main/ipc/system.ts (system:chooseFile)
     */
    chooseFile: (
      filters?: { name: string; extensions: string[] }[],
    ): Promise<{ filePaths: string[] }> =>
      window.api.system.chooseFile(filters ? { filters } : undefined),
    /**
     * Window controls for the custom frameless title bar — used by
     * `WindowFrame` to drive minimize / maximize-toggle / close.
     * @see src/renderer/src/topbar/WindowFrame.tsx
     * @see src/main/ipc/system.ts
     */
    window: {
      minimize: (): Promise<{ ok: true }> => window.api.system.window.minimize(),
      toggleMaximize: (): Promise<{ ok: true }> => window.api.system.window.toggleMaximize(),
      close: (): Promise<{ ok: true }> => window.api.system.window.close(),
    },
  },
}
