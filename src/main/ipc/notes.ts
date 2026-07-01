/**
 * IPC handler registration for notes / search / links channels.
 *
 * Why: Each handler is a thin wrapper that (1) parses the renderer's input
 * through the matching Zod schema and (2) delegates to the already-tested
 * query / save helpers. Validation lives at the IPC boundary per CLAUDE.md
 * §Stack ("Zod at IPC boundaries"), so a malformed payload from the renderer
 * can never reach a query function and trigger a SQLite error at runtime.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §IPC channels at v0.1
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 20
 */

import type Database from 'better-sqlite3'
import { ipcMain } from 'electron'
import type { SourceLocator } from '../../shared/types'
import {
  BacklinksInputSchema,
  CommentsOfInputSchema,
  FindSourceByPdfIdInputSchema,
  NoteIdSchema,
  NotesCreateInputSchema,
  NotesListInputSchema,
  NotesRecentInputSchema,
  NotesRecordAccessInputSchema,
  NotesUpdateInputSchema,
  ResolveInputSchema,
  SearchRunInputSchema,
  SettingsGetInputSchema,
  SettingsSetInputSchema,
} from '../../shared/zod-schemas'
import { backlinks, commentsForNote } from '../db/queries/links'
import { getNote, getSourceNoteByPdfId, listNotes } from '../db/queries/notes'
import { listTitles, recentNotes, recordAccess } from '../db/queries/recency'
import { resolveWikilink } from '../db/queries/resolver'
import { searchNotes } from '../db/queries/search'
import { getSetting, setSetting } from '../db/queries/settings'
import type { NotesDir } from '../files/notes-dir'
import { saveNote } from '../save-note'

type DB = Database.Database

/**
 * Wires every notes / search / links IPC channel to its query handler.
 *
 * Why: Called once from `registerAllIpc` after the DB and notes directory are
 * initialised. Each `ipcMain.handle` callback receives `unknown` from the
 * renderer; we parse via Zod before dispatch so the typed query layer never
 * sees an untrusted shape.
 *
 * `links:backlinks` performs a `getNote` lookup first, then calls the
 * `backlinks` query by slug. The plan returns `[]` when the source note id is
 * unknown — preserved here so a stale renderer cache never throws.
 *
 * @param db - Open better-sqlite3 Database used by every query handler.
 * @param nd - {@link NotesDir} threaded into `saveNote` for file-first writes.
 * @see docs/specs/v0.1-rolling-feed-and-search.md §IPC channels at v0.1
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 20 Step 1
 */
export function registerNotesIpc(db: DB, nd: NotesDir): void {
  ipcMain.handle('notes:list', (_e, input) => {
    const i = NotesListInputSchema.parse(input)
    // Conditional spread keeps `before` / `excludeThreadChildren` absent (not
    // `undefined`) so the call satisfies `exactOptionalPropertyTypes` against
    // listNotes' parameter type. The flag defaults to false/absent here so that
    // canvas pickers (EdgeTargetPicker, Picker, DevBootMeter) receive all notes
    // including comment-on children (PDF excerpts placed on canvas). Only the feed
    // passes `{ excludeThreadChildren: true }` — see App.tsx ('notes','feed') query.
    // @issue utof/linsae#165
    return listNotes(db, {
      limit: i.limit,
      ...(i.before !== undefined ? { before: i.before } : {}),
      ...(i.excludeThreadChildren ? { excludeThreadChildren: true } : {}),
    })
  })
  ipcMain.handle('notes:get', (_e, input) => {
    const i = NoteIdSchema.parse(input)
    return getNote(db, i.id)
  })
  ipcMain.handle('notes:create', (_e, input) => {
    const i = NotesCreateInputSchema.parse(input)
    // Cast source_locator to SourceLocator: Zod infers `t?: number | undefined`
    // but exactOptionalPropertyTypes requires `t?: number`. The schema validates
    // the shape at runtime; the cast is safe.
    return saveNote(db, nd, {
      mode: 'create',
      body: i.body,
      type: i.type,
      ...(i.source_kind ? { source_kind: i.source_kind } : {}),
      ...(i.source_locator ? { source_locator: i.source_locator as SourceLocator } : {}),
      ...(i.commentOn ? { commentOn: i.commentOn } : {}),
    })
  })
  ipcMain.handle('notes:update', (_e, input) => {
    const i = NotesUpdateInputSchema.parse(input)
    // Same cast rationale as notes:create above.
    return saveNote(db, nd, {
      mode: 'update',
      id: i.id,
      body: i.body,
      type: i.type,
      ...(i.source_kind ? { source_kind: i.source_kind } : {}),
      ...(i.source_locator ? { source_locator: i.source_locator as SourceLocator } : {}),
    })
  })
  ipcMain.handle('notes:delete', (_e, input) => {
    const i = NoteIdSchema.parse(input)
    return saveNote(db, nd, { mode: 'softDelete', id: i.id })
  })
  ipcMain.handle('search:run', (_e, input) => {
    const i = SearchRunInputSchema.parse(input)
    return searchNotes(db, i)
  })
  ipcMain.handle('links:backlinks', (_e, input) => {
    const i = BacklinksInputSchema.parse(input)
    const note = getNote(db, i.noteId)
    return note ? backlinks(db, note.slug) : []
  })
  ipcMain.handle('links:commentsOf', (_e, input) => {
    const i = CommentsOfInputSchema.parse(input)
    const note = getNote(db, i.noteId)
    return note ? commentsForNote(db, note.slug) : []
  })
  ipcMain.handle('links:resolve', (_e, input) => {
    const i = ResolveInputSchema.parse(input)
    return resolveWikilink(db, i.slug)
  })
  ipcMain.handle('settings:get', (_e, input) => {
    const i = SettingsGetInputSchema.parse(input)
    return { value: getSetting(db, i.key) }
  })
  ipcMain.handle('settings:set', (_e, input) => {
    const i = SettingsSetInputSchema.parse(input)
    setSetting(db, i.key, i.value)
    return { ok: true as const }
  })
  ipcMain.handle('notes:listTitles', () => listTitles(db))
  ipcMain.handle('notes:recent', (_e, input) => {
    const i = NotesRecentInputSchema.parse(input)
    return recentNotes(db, i)
  })
  ipcMain.handle('notes:recordAccess', (_e, input) => {
    const i = NotesRecordAccessInputSchema.parse(input)
    recordAccess(db, i.noteId)
    return { ok: true as const }
  })
  ipcMain.handle('notes:findSourceByPdfId', (_e, input) => {
    const i = FindSourceByPdfIdInputSchema.parse(input)
    return getSourceNoteByPdfId(db, i.pdfId)
  })
}
