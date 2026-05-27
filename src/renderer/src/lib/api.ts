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

import type { Note, SearchHit } from '../../../shared/types'

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
     * @see src/main/ipc/notes.ts
     */
    create: (body: string, type: Note['type'] = 'claim'): Promise<Note> =>
      window.api.notes.create({ body, type }),
    /**
     * Update an existing note's body / type. Why no default for `type`:
     * updates always carry an explicit type — the composer round-trips it.
     * @see src/main/ipc/notes.ts
     */
    update: (id: string, body: string, type: Note['type']): Promise<Note> =>
      window.api.notes.update({ id, body, type }),
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
  },
}
