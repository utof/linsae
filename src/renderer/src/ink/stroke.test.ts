/**
 * Unit tests for ink/stroke.ts — getSvgPathFromStroke vendored helper and strokeToPath.
 * Runs in happy-dom (the global renderer test env).
 * @see src/renderer/src/ink/stroke.ts
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Stroke geometry"
 */
import { describe, expect, it } from 'vitest'
// Use a dynamic import path so we test the private helper indirectly via the exported API,
// and the internal _getSvgPathFromStroke via the named export added for testing.
import { _getSvgPathFromStroke, STROKE_OPTS, strokeToPath } from './stroke'
import type { Stroke } from './types'

describe('_getSvgPathFromStroke (vendored helper)', () => {
  it('returns empty string for an empty points array', () => {
    expect(_getSvgPathFromStroke([])).toBe('')
  })

  it('returns empty string for 1 point', () => {
    expect(_getSvgPathFromStroke([[0, 0]])).toBe('')
  })

  it('returns empty string for 2 points', () => {
    expect(
      _getSvgPathFromStroke([
        [0, 0],
        [10, 10],
      ]),
    ).toBe('')
  })

  it('returns empty string for exactly 3 points', () => {
    expect(
      _getSvgPathFromStroke([
        [0, 0],
        [10, 10],
        [20, 5],
      ]),
    ).toBe('')
  })

  it('returns a path string starting with M and ending with Z for ≥4 points', () => {
    const points = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]
    const result = _getSvgPathFromStroke(points)
    expect(result).not.toBe('')
    expect(result.startsWith('M')).toBe(true)
    expect(result.endsWith('Z')).toBe(true)
  })

  it('returns a non-closed path when closed=false', () => {
    const points = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]
    const result = _getSvgPathFromStroke(points, false)
    expect(result.endsWith('Z')).toBe(false)
  })
})

describe('STROKE_OPTS', () => {
  it('has the expected tuned constants', () => {
    expect(STROKE_OPTS).toEqual({ thinning: 0.5, smoothing: 0.5, streamline: 0.5 })
  })
})

describe('strokeToPath', () => {
  /**
   * A 3-point stroke is too few for the outline polygon to have ≥4 points;
   * but the spec says strokeToPath with a 3-point hand-stroke returns non-empty
   * because getStroke inflates the input to an outline polygon that CAN have ≥4 points
   * even from 3 input points when size > 0.  We verify non-empty here.
   */
  it('returns non-empty string for a 3-point stroke with non-zero size', () => {
    const stroke: Stroke = {
      id: 'test-stroke-1',
      kind: 'stroke',
      color: '#ff0000',
      size: 8,
      simulatePressure: true,
      points: [
        { x: 10, y: 10, pressure: 0.5 },
        { x: 50, y: 30, pressure: 0.7 },
        { x: 90, y: 10, pressure: 0.3 },
      ],
    }
    const result = strokeToPath(stroke)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns empty string for a stroke with 0 points', () => {
    const stroke: Stroke = {
      id: 'empty-stroke',
      kind: 'stroke',
      color: '#000',
      size: 8,
      simulatePressure: true,
      points: [],
    }
    expect(strokeToPath(stroke)).toBe('')
  })

  /**
   * Snapshot test: two strokes identical except simulatePressure produce different `d` values.
   * Uses uneven spacing AND varied recorded pressure (0.1, 0.9, 0.3, 0.8) so simulated pressure
   * (derived from velocity) cannot coincidentally match recorded pressure and flake the test.
   * This proves that simulatePressure=false correctly threads recorded pressure into getStroke.
   */
  it('produces different path d when simulatePressure differs (proves flag threading)', () => {
    // Points have very uneven spacing AND varied pressure — velocity-derived
    // pressure will differ strongly from the recorded values.
    const points = [
      { x: 0, y: 0, pressure: 0.1 },
      { x: 5, y: 2, pressure: 0.9 }, // short jump, high pressure
      { x: 100, y: 80, pressure: 0.3 }, // long jump, low pressure
      { x: 102, y: 82, pressure: 0.8 }, // short jump, high pressure
      { x: 200, y: 10, pressure: 0.1 }, // long jump, low pressure
    ]
    const base: Omit<Stroke, 'simulatePressure'> = {
      id: 'sim-test',
      kind: 'stroke',
      color: '#000',
      size: 10,
      points,
    }
    const withSimulate: Stroke = { ...base, simulatePressure: true }
    const withRealPressure: Stroke = { ...base, simulatePressure: false }

    const dSimulated = strokeToPath(withSimulate)
    const dReal = strokeToPath(withRealPressure)

    expect(dSimulated).not.toBe('')
    expect(dReal).not.toBe('')
    // The two paths MUST differ because simulated uses velocity-derived pressure
    // while recorded uses the explicit (highly varied) pressure values.
    expect(dSimulated).not.toBe(dReal)
  })
})
