/**
 * Per-canvas camera persistence (spec §1). Default camera {0,0,1} when no row
 * exists — first open of any canvas lands at world origin, zoom 100%.
 * Why: keyed by canvas_id only (no arrangement) — the camera is a property of
 * the surface, not of a position-set (spec §2).
 */
import type Database from 'better-sqlite3'
import type { CanvasCamera } from '../../../shared/canvas'

type DB = Database.Database

/**
 * Camera for a canvas; default {0,0,1} when never saved (first open lands at
 * world origin, zoom 100%).
 * @see docs/specs/v0.4-canvas-mvp.md §1 §2
 */
export function getCanvasState(db: DB, canvasId: string): CanvasCamera {
  const row = db
    .prepare(`SELECT camera_x, camera_y, zoom FROM canvas_state WHERE canvas_id = ?`)
    .get(canvasId) as CanvasCamera | undefined
  return row ?? { camera_x: 0, camera_y: 0, zoom: 1 }
}

/**
 * Upsert the camera row. Debounce lives renderer-side (≥500 ms + flush on
 * drop/view-switch/quit) — this function is a plain write.
 * @see docs/specs/v0.4-canvas-mvp.md §2 (persistence cadence)
 */
export function setCanvasState(db: DB, canvasId: string, cam: CanvasCamera): void {
  db.prepare(
    `INSERT INTO canvas_state (canvas_id, camera_x, camera_y, zoom, updated_at)
     VALUES (@canvasId, @camera_x, @camera_y, @zoom, @now)
     ON CONFLICT (canvas_id) DO UPDATE SET
       camera_x = excluded.camera_x, camera_y = excluded.camera_y,
       zoom = excluded.zoom, updated_at = excluded.updated_at`,
  ).run({ canvasId, ...cam, now: Date.now() })
}
