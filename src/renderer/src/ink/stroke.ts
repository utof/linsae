/**
 * Stroke geometry — converts raw InkPoints to an SVG path `d` string via perfect-freehand.
 *
 * This is the ONLY file in ink/ that imports perfect-freehand. The vendored helper
 * `_getSvgPathFromStroke` is re-exported with an underscore-prefix for testing only;
 * callers should use `strokeToPath`.
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Stroke geometry"
 * @see adrs/0025-drawing-overlay-format.md
 */
import { getStroke } from 'perfect-freehand'
import type { Stroke } from './types'

/**
 * Fixed feel constants for screenshot markup strokes.
 * Values tuned for annotation use: moderate thinning/smoothing/streamline (0.5 each).
 * Why const: callers spread these into getStroke options alongside per-stroke overrides.
 * @see https://github.com/steveruizok/perfect-freehand#readme
 */
export const STROKE_OPTS = { thinning: 0.5, smoothing: 0.5, streamline: 0.5 } as const

/**
 * Converts a `getStroke` outline polygon into an SVG path `d` string.
 * Returns `''` when the polygon has fewer than 4 points (not enough to draw a curve).
 * Vendored from the perfect-freehand README with `closed=true` default.
 *
 * Why vendored: `getSvgPathFromStroke` is NOT exported by the package — it is a
 * copy-paste helper the README provides for consumers.
 *
 * Exported as `_getSvgPathFromStroke` (underscore = test-accessible internal) so
 * tests can assert the helper's contract independently of `strokeToPath`.
 *
 * @see https://github.com/steveruizok/perfect-freehand#rendering
 */
export function _getSvgPathFromStroke(points: number[][], closed = true): string {
  const len = points.length

  if (len < 4) {
    return ''
  }

  // After the `len < 4` guard, indices 0–2 are guaranteed to exist.
  // noUncheckedIndexedAccess requires explicit non-null assertions here.
  let a = points[0]!
  let b = points[1]!
  const c = points[2]!

  const average = (x: number, y: number) => (x + y) / 2

  let result = `M${a[0]!.toFixed(2)},${a[1]!.toFixed(2)} Q${b[0]!.toFixed(2)},${b[1]!.toFixed(2)} ${average(b[0]!, c[0]!).toFixed(2)},${average(b[1]!, c[1]!).toFixed(2)} T`

  for (let i = 2, max = len - 1; i < max; i++) {
    a = points[i]! // i in [2, len-2] by loop bounds — always defined
    b = points[i + 1]! // i+1 in [3, len-1] by loop bounds — always defined
    result += `${average(a[0]!, b[0]!).toFixed(2)},${average(a[1]!, b[1]!).toFixed(2)} `
  }

  if (closed) {
    result += 'Z'
  }

  return result
}

/**
 * Converts a `Stroke` (raw input points) into an SVG path `d` string (outline polygon).
 *
 * CRITICAL — `simulatePressure`:
 * `getStroke` defaults `simulatePressure` to `true`, which derives pressure from
 * velocity and **silently ignores** the recorded per-point pressure values. A stylus's
 * real pressure is dead data unless we pass `simulatePressure: false`. The editor sets
 * this flag false when `pointerType === 'pen'` (real pressure available) and true for
 * mouse/touch (no real pressure → simulate from velocity).
 *
 * Why recompute on render (not cache): the outline must re-tessellate at any render
 * size so strokes stay crisp; storing the outline would fix it to one resolution.
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Stroke geometry"
 * @see adrs/0026-overlay-render-inline-svg.md
 */
export function strokeToPath(stroke: Stroke): string {
  const outline = getStroke(
    stroke.points.map((p) => [p.x, p.y, p.pressure]),
    { size: stroke.size, simulatePressure: stroke.simulatePressure, ...STROKE_OPTS },
  )
  return _getSvgPathFromStroke(outline)
}
