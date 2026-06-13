/**
 * Pure selection/marquee/centroid math (spec §8, §14). World-space rects.
 * @see docs/specs/v0.4-canvas-mvp.md §8 §14
 */
import { describe, expect, it } from 'vitest'
import { centroid, marqueeRect, NUDGE_PX, nudgeDelta } from './selection-geometry'

describe('marqueeRect', () => {
  it('normalizes any two world points into a min/max rect', () => {
    expect(marqueeRect({ x: 30, y: 40 }, { x: 10, y: 5 })).toEqual({
      minX: 10,
      minY: 5,
      maxX: 30,
      maxY: 40,
    })
  })
})

describe('centroid', () => {
  it('averages card centers (top-left + w/2, h/2)', () => {
    const c = centroid([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 200, y: 200, w: 100, h: 100 },
    ])
    expect(c).toEqual({ x: 150, y: 150 }) // centers (50,50) & (250,250)
  })
  it('returns null for an empty set', () => {
    expect(centroid([])).toBeNull()
  })
})

describe('nudgeDelta', () => {
  it(`maps arrow keys to ±${NUDGE_PX} world px`, () => {
    expect(nudgeDelta('ArrowLeft')).toEqual({ dx: -NUDGE_PX, dy: 0 })
    expect(nudgeDelta('ArrowRight')).toEqual({ dx: NUDGE_PX, dy: 0 })
    expect(nudgeDelta('ArrowUp')).toEqual({ dx: 0, dy: -NUDGE_PX })
    expect(nudgeDelta('ArrowDown')).toEqual({ dx: 0, dy: NUDGE_PX })
    expect(nudgeDelta('Enter')).toBeNull()
  })
})
