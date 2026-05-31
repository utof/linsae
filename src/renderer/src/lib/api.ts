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

import type { Attachment, Note, SearchHit, SourceLocator } from '../../../shared/types'

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
     * payload; defaults (e.g. `limit: 100`) are applied by the main-process
     * Zod parse on `NotesListInputSchema`.
     * @see src/main/ipc/notes.ts
     */
    list: (input?: { limit?: number; before?: number }): Promise<Note[]> =>
      window.api.notes.list(input ?? {}),
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
     * `source` carries the optional YouTube-annotation fields added in v0.2:
     * `source_kind` / `source_locator` link the note to a media position;
     * `commentOn` sets the parent video slug for thread-child notes.
     * Undefined fields are omitted (not passed as `undefined`) to satisfy
     * `exactOptionalPropertyTypes` and the Zod `optional()` contract.
     *
     * @see src/main/ipc/notes.ts
     * @see docs/specs/v0.2-youtube-annotation.md §Data model
     */
    create: (
      body: string,
      type: Note['type'] = 'claim',
      source?: { source_kind?: 'youtube'; source_locator?: SourceLocator; commentOn?: string },
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
     * `source` carries optional YouTube-annotation fields added in v0.2:
     * `source_kind` / `source_locator` (no `commentOn` — threads don't
     * move parents post-creation). Undefined fields are omitted to satisfy
     * `exactOptionalPropertyTypes`.
     *
     * @see src/main/ipc/notes.ts
     * @see docs/specs/v0.2-youtube-annotation.md §Data model
     */
    update: (
      id: string,
      body: string,
      type: Note['type'],
      source?: { source_kind?: 'youtube'; source_locator?: SourceLocator },
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
     * Fetch cached title/channel for a video, or null if not yet upserted.
     * @see src/main/ipc/videoSources.ts
     */
    get: (videoId: string): Promise<{ title: string | null; channel: string | null } | null> =>
      window.api.videoSources.get({ videoId }),
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
