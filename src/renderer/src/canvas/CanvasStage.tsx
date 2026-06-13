/**
 * The canvas stage shell: a focusable, overflow-hidden viewport containing a
 * single transformed world container. Cards arrive in Task 6 — this task ships
 * the viewport + camera wiring + world transform only.
 *
 * Why a separate transformed container (vs transforming the viewport): the
 * viewport stays a fixed, clip-bounding box (`overflow: hidden`) while the world
 * pans/zooms underneath it; future overlays (edges, selection box) can sit in
 * the viewport's untransformed space alongside the world.
 *
 * The `onWikilinkClick` / `resolveSlug` props are threaded to cards in Task 6;
 * they are accepted now so App wiring is final and doesn't churn next task.
 *
 * No `content-visibility` anywhere on this surface (spec product decision 6).
 *
 * @see docs/specs/v0.4-canvas-mvp.md §3 (stage transform)
 * @see src/renderer/src/canvas/useCanvasCamera.ts
 */
import { useRef } from 'react'
import { ROOT_CANVAS_ID } from '../../../shared/canvas'
import { useCanvasCamera } from './useCanvasCamera'

interface Props {
  /** Navigate to (or draft) the note for a clicked `[[slug]]` wikilink. */
  onWikilinkClick: (slug: string) => void
  /** Synchronous dangling-class check for a wikilink slug (render pass). */
  resolveSlug: (slug: string) => boolean
}

/**
 * Renders the canvas viewport for the root canvas. The viewport div always
 * mounts (gestures bind immediately, layout is stable), but the world
 * container is gated on the camera hook's `ready` flag — its first paint is
 * at the persisted camera, never {0,0,1}-then-jump.
 */
export function CanvasStage(_props: Props): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const { camera, ready } = useCanvasCamera(ROOT_CANVAS_ID, viewportRef, { unclampZoom: false })

  return (
    // tabIndex makes the viewport focusable so canvas-scoped hotkeys can check
    // focus (Task 6+). The world transform composes a translate (negated, in
    // screen px) with a scale — origin 0,0 so world coords map linearly.
    <div
      ref={viewportRef}
      // tabIndex makes the pannable canvas surface focusable so canvas-scoped
      // hotkeys can gate on focus (Task 6+); the plan mandates a focusable
      // viewport div. role="application" marks it as an interactive widget
      // region (the canvas owns its own keyboard interaction model).
      role="application"
      aria-label="canvas"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: canvas is a focusable spatial widget (role=application) owning its own keyboard model; plan mandates a focusable viewport so canvas-scoped hotkeys can gate on focus
      tabIndex={0}
      data-canvas-viewport
      style={{
        flex: 1,
        overflow: 'hidden',
        position: 'relative',
        background: 'var(--bg-0)',
        outline: 'none',
      }}
    >
      {ready && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            transformOrigin: '0 0',
            transform:
              `translate(${-camera.x * camera.zoom}px, ${-camera.y * camera.zoom}px)` +
              ` scale(${camera.zoom})`,
          }}
          data-canvas-world
        />
      )}
    </div>
  )
}
