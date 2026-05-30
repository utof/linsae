// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { clampRect } from './rect-clamp'

const view = { width: 1000, height: 800 }

describe('clampRect', () => {
  it('passes a fully-in-bounds rect through, rounded to integers', () => {
    expect(clampRect({ x: 10.4, y: 20.6, width: 100.5, height: 50.2 }, view)).toEqual({
      x: 10,
      y: 21,
      width: 101,
      height: 50,
    })
  })

  it('clamps a rect that overflows the right/bottom edge', () => {
    expect(clampRect({ x: 900, y: 700, width: 400, height: 400 }, view)).toEqual({
      x: 900,
      y: 700,
      width: 100,
      height: 100,
    })
  })

  it('clamps negative origin to 0 and shrinks width accordingly', () => {
    expect(clampRect({ x: -50, y: -30, width: 200, height: 100 }, view)).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 70,
    })
  })
})
