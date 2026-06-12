// @vitest-environment node
/** Camera persistence round-trip (spec §1 §2). */
import { beforeEach, describe, expect, it } from 'vitest'
import { ROOT_CANVAS_ID } from '../../../shared/canvas'
import { openDb } from '../client'
import { runMigrations } from '../migrate'
import { getCanvasState, setCanvasState } from './canvas-state'

let db: ReturnType<typeof openDb>
beforeEach(() => {
  db = openDb(':memory:')
  runMigrations(db)
})

describe('canvas_state', () => {
  it('returns the default camera when no row exists', () => {
    expect(getCanvasState(db, ROOT_CANVAS_ID)).toEqual({ camera_x: 0, camera_y: 0, zoom: 1 })
  })
  it('upserts and round-trips', () => {
    setCanvasState(db, ROOT_CANVAS_ID, { camera_x: -120.5, camera_y: 88, zoom: 0.75 })
    expect(getCanvasState(db, ROOT_CANVAS_ID)).toEqual({
      camera_x: -120.5,
      camera_y: 88,
      zoom: 0.75,
    })
    setCanvasState(db, ROOT_CANVAS_ID, { camera_x: 1, camera_y: 2, zoom: 2 })
    expect(getCanvasState(db, ROOT_CANVAS_ID)).toEqual({ camera_x: 1, camera_y: 2, zoom: 2 })
  })
})
