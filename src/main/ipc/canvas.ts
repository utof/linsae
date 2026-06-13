/**
 * IPC for the v0.4 canvas data layer: layouts, edges, camera state, recency.
 * Thin glue — each handler Zod-parses then delegates to a tested wrapper.
 * @see docs/specs/v0.4-canvas-mvp.md §2
 */
import type Database from 'better-sqlite3'
import { ipcMain } from 'electron'
import {
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
} from '../../shared/zod-schemas'
import { canvasEdges } from '../db/queries/canvas-edges'
import { getCanvasState, setCanvasState } from '../db/queries/canvas-state'
import { createDrawnEdge, deleteDrawnEdge } from '../db/queries/edges'
import {
  createNoteAt,
  listLayouts,
  moveNotes,
  placeNote,
  recentOnCanvas,
  removeNotes,
  restoreLayouts,
  shelveNote,
  unplaceNotes,
} from '../db/queries/layouts'
import type { NotesDir } from '../files/notes-dir'

type DB = Database.Database

/**
 * Wires the canvas:* channels. Called once from `registerAllIpc`.
 * Why: same thin posture as registerNotesIpc/registerMediaIpc — handlers
 * contain zero logic so the wrappers' colocated tests are the real coverage.
 * Takes `nd` (the NotesDir) because `canvas:createNoteAt` writes a markdown
 * file first / DB second, exactly like the notes channels (spec §7).
 * @param db - Open better-sqlite3 Database.
 * @param nd - {@link NotesDir} pointed at the user's notes directory.
 * @see docs/specs/v0.4-canvas-mvp.md §2 §7
 */
export function registerCanvasIpc(db: DB, nd: NotesDir): void {
  ipcMain.handle('canvas:listLayouts', (_e, input) =>
    listLayouts(db, CanvasListLayoutsInputSchema.parse(input)),
  )
  ipcMain.handle('canvas:edges', (_e, input) =>
    canvasEdges(db, CanvasEdgesInputSchema.parse(input)),
  )
  ipcMain.handle('canvas:shelveNote', (_e, input) =>
    shelveNote(db, CanvasShelveNoteInputSchema.parse(input)),
  )
  ipcMain.handle('canvas:placeNote', (_e, input) =>
    placeNote(db, CanvasPlaceNoteInputSchema.parse(input)),
  )
  ipcMain.handle('canvas:moveNotes', (_e, input) =>
    moveNotes(db, CanvasMoveNotesInputSchema.parse(input)),
  )
  ipcMain.handle('canvas:unplaceNotes', (_e, input) =>
    unplaceNotes(db, CanvasNoteIdsInputSchema.parse(input)),
  )
  ipcMain.handle('canvas:restoreLayouts', (_e, input) =>
    restoreLayouts(db, CanvasRestoreLayoutsInputSchema.parse(input)),
  )
  ipcMain.handle('canvas:removeNotes', (_e, input) =>
    removeNotes(db, CanvasNoteIdsInputSchema.parse(input)),
  )
  ipcMain.handle('canvas:getState', (_e, input) =>
    getCanvasState(db, CanvasGetStateInputSchema.parse(input).canvasId),
  )
  ipcMain.handle('canvas:setState', (_e, input) => {
    const i = CanvasSetStateInputSchema.parse(input)
    setCanvasState(db, i.canvasId, { camera_x: i.camera_x, camera_y: i.camera_y, zoom: i.zoom })
  })
  ipcMain.handle('canvas:recentOnCanvas', (_e, input) =>
    recentOnCanvas(db, CanvasRecentInputSchema.parse(input)),
  )
  ipcMain.handle('canvas:createNoteAt', (_e, input) =>
    createNoteAt(db, nd, CanvasCreateNoteAtInputSchema.parse(input)),
  )
  ipcMain.handle('canvas:createEdge', (_e, input) =>
    createDrawnEdge(db, CanvasCreateEdgeInputSchema.parse(input)),
  )
  ipcMain.handle('canvas:deleteEdge', (_e, input) =>
    deleteDrawnEdge(db, CanvasDeleteEdgeInputSchema.parse(input)),
  )
}
