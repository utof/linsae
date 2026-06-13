/**
 * Thin rbush wrapper — §16 future contract (dot hit-testing, ink culling
 * reuse it later). Update-in-place = remove+insert (rbush has no update()).
 * @see docs/specs/v0.4-canvas-mvp.md §3 §16
 */
import { describe, expect, it } from 'vitest'
import { CardSpatialIndex } from './spatial-index'

describe('CardSpatialIndex', () => {
  it('search returns ids of cards intersecting the rect', () => {
    const idx = new CardSpatialIndex()
    idx.setCard('a', { x: 0, y: 0, w: 360, h: 140 })
    idx.setCard('b', { x: 1000, y: 1000, w: 360, h: 140 })
    expect(idx.search({ minX: -10, minY: -10, maxX: 10, maxY: 10 }).sort()).toEqual(['a'])
    expect(idx.search({ minX: 0, minY: 0, maxX: 2000, maxY: 2000 }).sort()).toEqual(['a', 'b'])
  })

  it('setCard on an existing id moves it (remove+insert), no duplicates', () => {
    const idx = new CardSpatialIndex()
    idx.setCard('a', { x: 0, y: 0, w: 360, h: 140 })
    idx.setCard('a', { x: 5000, y: 5000, w: 360, h: 200 })
    expect(idx.search({ minX: -100, minY: -100, maxX: 100, maxY: 100 })).toEqual([])
    expect(idx.search({ minX: 4900, minY: 4900, maxX: 5100, maxY: 5100 })).toEqual(['a'])
  })

  it('removeCard deletes; removing an absent id is a no-op', () => {
    const idx = new CardSpatialIndex()
    idx.setCard('a', { x: 0, y: 0, w: 360, h: 140 })
    idx.removeCard('a')
    idx.removeCard('ghost')
    expect(idx.search({ minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 })).toEqual([])
  })

  it('rebuild bulk-loads a fresh set', () => {
    const idx = new CardSpatialIndex()
    idx.setCard('old', { x: 0, y: 0, w: 360, h: 140 })
    idx.rebuild([
      { id: 'a', rect: { x: 0, y: 0, w: 360, h: 140 } },
      { id: 'b', rect: { x: 400, y: 0, w: 360, h: 140 } },
    ])
    expect(idx.search({ minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 }).sort()).toEqual(['a', 'b'])
  })
})
