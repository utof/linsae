/**
 * Pure camera math: world↔screen, zoom-about-cursor, clamp, culling rect.
 * @see docs/specs/v0.4-canvas-mvp.md §3
 */
import { describe, expect, it } from 'vitest'
import {
  centerCamera,
  clampZoom,
  fitCamera,
  panBy,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomAboutPoint,
} from './camera'

describe('camera math', () => {
  it('world↔screen round-trips', () => {
    const c = { x: 100, y: -50, zoom: 2 }
    const s = worldToScreen(c, { x: 130, y: -20 })
    expect(s).toEqual({ x: 60, y: 60 })
    expect(screenToWorld(c, s)).toEqual({ x: 130, y: -20 })
  })

  it('clampZoom pins to [0.5, 2.0] and the floor equals the title threshold', () => {
    expect(ZOOM_MIN).toBe(0.5)
    expect(ZOOM_MAX).toBe(2.0)
    expect(clampZoom(0.1)).toBe(0.5)
    expect(clampZoom(3)).toBe(2)
    expect(clampZoom(1)).toBe(1)
  })

  it('zoomAboutPoint keeps the world point under the cursor fixed', () => {
    const c = { x: 0, y: 0, zoom: 1 }
    const cursor = { x: 200, y: 100 }
    const before = screenToWorld(c, cursor)
    const zoomed = zoomAboutPoint(c, cursor, 1.5)
    expect(screenToWorld(zoomed, cursor).x).toBeCloseTo(before.x)
    expect(screenToWorld(zoomed, cursor).y).toBeCloseTo(before.y)
    expect(zoomed.zoom).toBeCloseTo(1.5)
  })

  it('zoomAboutPoint clamps by default and unclamps on request (dev LOD flag)', () => {
    const c = { x: 0, y: 0, zoom: 0.6 }
    expect(zoomAboutPoint(c, { x: 0, y: 0 }, 0.1).zoom).toBe(0.5)
    expect(zoomAboutPoint(c, { x: 0, y: 0 }, 0.1, { clamp: false }).zoom).toBeCloseTo(0.06)
  })

  it('panBy moves the camera opposite the screen-space drag delta', () => {
    const c = { x: 10, y: 10, zoom: 2 }
    expect(panBy(c, { dx: 20, dy: -10 })).toEqual({ x: 0, y: 15, zoom: 2 })
  })

  it('visibleWorldRect inflates by one viewport on each side (spec §3 culling)', () => {
    const c = { x: 0, y: 0, zoom: 1 }
    const r = visibleWorldRect(c, 800, 600, 1)
    expect(r).toEqual({ minX: -800, minY: -600, maxX: 1600, maxY: 1200 })
    const tight = visibleWorldRect(c, 800, 600, 0)
    expect(tight).toEqual({ minX: 0, minY: 0, maxX: 800, maxY: 600 })
  })
})

describe('fitCamera', () => {
  it('frames all rects with padding, clamped to the zoom range', () => {
    const c = fitCamera(
      [
        { x: 0, y: 0, w: 100, h: 100 },
        { x: 900, y: 400, w: 100, h: 100 },
      ],
      800,
      600,
      0,
    )
    // content spans 1000×500; 800/1000 = 0.8 fits width → clamped to >=0.5 ok
    expect(c.zoom).toBeGreaterThanOrEqual(0.5)
    expect(c.zoom).toBeLessThanOrEqual(2)
    // content center (500,250) sits at the viewport center after fit
    const cx = c.x + 800 / c.zoom / 2
    const cy = c.y + 600 / c.zoom / 2
    expect(cx).toBeCloseTo(500)
    expect(cy).toBeCloseTo(250)
  })
  it('returns the current camera for an empty rect set (fit is a no-op)', () => {
    const cur = { x: 5, y: 6, zoom: 1.3 }
    expect(fitCamera([], 800, 600, 40, cur)).toEqual(cur)
  })
})

describe('centerCamera', () => {
  it('centers a single rect in the viewport at the given zoom', () => {
    const c = centerCamera({ x: 100, y: 100, w: 360, h: 140 }, 800, 600, 1)
    const cx = c.x + 800 / c.zoom / 2
    const cy = c.y + 600 / c.zoom / 2
    expect(cx).toBeCloseTo(280) // 100 + 360/2
    expect(cy).toBeCloseTo(170) // 100 + 140/2
    expect(c.zoom).toBe(1)
  })
})
