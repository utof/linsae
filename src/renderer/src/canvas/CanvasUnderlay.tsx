/**
 * A 2D canvas underlay that sits beneath the card world container, drawn in
 * world coordinates. Layers are called during the rAF callback after the
 * camera+dpr transform is applied, so each layer can draw directly in world
 * space without any extra math.
 *
 * Dirty-flag rAF: the loop only redraws when a dirty flag is set. The flag is
 * marked during render whenever camera, size, or layer identity changes
 * (ref mutation during render is safe — it's not a state update). This matches
 * spec §3 (underlay cadence): no redraw without a dirty mark.
 *
 * The component mounts cleanly in happy-dom (test env) where getContext('2d')
 * returns null — all draw work is skipped, so tests assert wiring only.
 *
 * @see docs/specs/v0.4-canvas-mvp.md §3 §11 §16
 * @see src/renderer/src/canvas/CanvasStage.tsx
 */
import { useEffect, useRef } from 'react'
import type { Camera } from './camera'

/**
 * A draw callback operating in world coordinates. The context already carries
 * the camera+dpr transform when `draw` is called, so callers draw in world
 * space directly.
 *
 * Why a generic interface (not edges-only): this is the §16 ink seam — dots,
 * selection rectangles, and ink strokes all arrive via this contract later.
 */
export interface UnderlayLayer {
  /**
   * Draw in WORLD coordinates; ctx already carries the camera+dpr transform.
   * @see docs/specs/v0.4-canvas-mvp.md §16
   */
  draw(ctx: CanvasRenderingContext2D, camera: Camera): void
}

interface CanvasUnderlayProps {
  camera: Camera
  /** Layers to draw in order; each draws in world coordinates. */
  layers: UnderlayLayer[]
  /** Viewport width in CSS px. */
  width: number
  /** Viewport height in CSS px. */
  height: number
}

/**
 * Renders a `<canvas>` underlay sized to the viewport, absolutely positioned
 * under the card world container. Pointer events are disabled so the canvas
 * does not intercept pan/zoom gestures.
 *
 * Transform applied before each `layer.draw(ctx, camera)`:
 *   ctx.setTransform(dpr * z, 0, 0, dpr * z, -camera.x * z * dpr, -camera.y * z * dpr)
 * This maps world coordinates directly to canvas backing-store pixels.
 *
 * @see docs/specs/v0.4-canvas-mvp.md §3 §11
 */
export function CanvasUnderlay({
  camera,
  layers,
  width,
  height,
}: CanvasUnderlayProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Refs so the rAF loop always reads current props without restarting.
  const cameraRef = useRef(camera)
  const layersRef = useRef(layers)
  const widthRef = useRef(width)
  const heightRef = useRef(height)

  // dirty flag: true on mount; set during render when any drawing input changes.
  // Ref mutation during render is safe (not a state update, no re-render triggered).
  const dirtyRef = useRef(true)

  // Detect prop changes by comparing to previous values stored in refs.
  // When any input changes, mark dirty so the next rAF tick redraws.
  if (
    cameraRef.current !== camera ||
    layersRef.current !== layers ||
    widthRef.current !== width ||
    heightRef.current !== height
  ) {
    dirtyRef.current = true
  }

  // Update refs to current prop values after the dirty check.
  cameraRef.current = camera
  layersRef.current = layers
  widthRef.current = width
  heightRef.current = height

  // rAF loop: starts once on mount, cancels on unmount. Reads all drawing
  // inputs from refs so it never needs restarting on prop change. Redraws
  // only when the dirty flag is set (spec §3 underlay cadence).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let rafId = 0

    const loop = (): void => {
      rafId = requestAnimationFrame(loop)

      if (!dirtyRef.current) return
      dirtyRef.current = false

      const ctx = canvas.getContext('2d')
      // No-op when getContext returns null (happy-dom has no 2D raster engine).
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      const cam = cameraRef.current
      const z = cam.zoom
      const w = widthRef.current
      const h = heightRef.current

      // Resize backing store to CSS size × dpr if needed.
      const bsW = Math.round(w * dpr)
      const bsH = Math.round(h * dpr)
      if (canvas.width !== bsW) canvas.width = bsW
      if (canvas.height !== bsH) canvas.height = bsH

      // Why: identity before clear — clearRect respects the current transform
      // matrix; the previous frame left it at the camera matrix, so clearing
      // under identity is required to wipe the whole backing store (happy-dom
      // can't catch this — getContext returns null there).
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // Camera+dpr transform: world coords → backing-store pixels.
      // Formula: spec §3 underlay transform.
      ctx.setTransform(dpr * z, 0, 0, dpr * z, -cam.x * z * dpr, -cam.y * z * dpr)

      for (const layer of layersRef.current) {
        ctx.save()
        layer.draw(ctx, cam)
        ctx.restore()
      }
    }

    rafId = requestAnimationFrame(loop)

    return (): void => {
      cancelAnimationFrame(rafId)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width,
        height,
        pointerEvents: 'none',
      }}
    />
  )
}
