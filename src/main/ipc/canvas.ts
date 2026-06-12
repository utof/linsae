/**
 * IPC for the v0.4 canvas data layer: layouts, edges, camera state, recency.
 * Thin glue — each handler Zod-parses then delegates to a tested wrapper.
 * @see docs/specs/v0.4-canvas-mvp.md §2
 */
import type Database from 'better-sqlite3'
import { ipcMain } from 'electron'
import {
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
import {
  listLayouts,
  moveNotes,
  placeNote,
  recentOnCanvas,
  removeNotes,
  restoreLayouts,
  shelveNote,
  unplaceNotes,
} from '../db/queries/layouts'

type DB = Database.Database

/**
 * Wires the canvas:* channels. Called once from `registerAllIpc`.
 * Why: same thin posture as registerNotesIpc/registerMediaIpc — handlers
 * contain zero logic so the wrappers' colocated tests are the real coverage.
 * @see docs/specs/v0.4-canvas-mvp.md §2
 */
export function registerCanvasIpc(db: DB): void {
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
}
