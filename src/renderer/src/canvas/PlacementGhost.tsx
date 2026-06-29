import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Screen-space preview footprint, mirroring the canvas card at 1:1 (CanvasStage's
 * module-private `CARD_WIDTH` / `DEFAULT_CARD_HEIGHT`). Local copies keep this
 * window-level overlay decoupled from CanvasStage's internals — the ghost is a
 * fixed-size "note in hand", not a zoom-scaled world card.
 */
const GHOST_WIDTH = 360
const GHOST_MIN_HEIGHT = 140

interface Props {
  /** Note title rendered inside the preview card (the canvas banner shows it too). */
  title: string
}

/** A cursor sample plus whether the element under it is the canvas drop surface. */
interface GhostPos {
  x: number
  y: number
  overCanvas: boolean
}

/**
 * Window-level one-shot placement ghost (B16). While a placement is active
 * (`App.placing != null`) App mounts this so the note being placed follows the
 * cursor across the ENTIRE window — over the right dock / PDF reader and other
 * chrome — giving continuous visual proof that a note is "in hand". Before B16
 * the ghost lived inside CanvasStage and only painted within the canvas
 * viewport, so excerpting from the PDF (where the cursor sits when the user
 * clicks "place on canvas") showed no card, only the subtle top banner.
 *
 * This is the SINGLE ghost: CanvasStage no longer renders a world-space ghost,
 * so the two can never double up at the same screen point. The drop still
 * commits ONLY on the canvas, via CanvasStage's viewport click→`placeAt` path;
 * this overlay is `pointerEvents:'none'` and never intercepts the click. Over a
 * non-canvas region the card dims and shows a "release over the canvas" hint —
 * a click there hits the dock/PDF, not the canvas, so nothing is committed.
 *
 * Portaled to `document.body` so it escapes the layout's `overflow:hidden` stage
 * containers and paints above the dock. z-index 900 sits below modals (palette /
 * settings / context menu at 1000); placement is mutually exclusive with those.
 *
 * Why it appears only after the first pointermove: there is no synchronous API to
 * read the cursor position on mount, so the ghost shows the instant the user
 * moves (the banner is the until-then cue). This mirrors the prior world-space
 * ghost, which likewise needed a move to seed its position.
 *
 * @see src/renderer/src/App.tsx — `placing` state + the excerpt / Flow-A bridges
 * @see src/renderer/src/canvas/CanvasStage.tsx — viewport click commit (`placeAt`)
 */
export function PlacementGhost({ title }: Props): React.ReactElement | null {
  const [pos, setPos] = useState<GhostPos | null>(null)

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const target = e.target as Element | null
      const overCanvas = target?.closest('[data-canvas-viewport]') != null
      setPos({ x: e.clientX, y: e.clientY, overCanvas })
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [])

  if (!pos) return null

  return createPortal(
    <div
      data-placement-ghost
      data-over-canvas={String(pos.overCanvas)}
      aria-hidden="true"
      style={{
        position: 'fixed',
        // Anchor the card's TOP-LEFT at the cursor: the drop commits at the click
        // point as the card's top-left (api.canvas.placeNote x/y), so the preview
        // lines up with where the card will actually land.
        left: pos.x,
        top: pos.y,
        width: GHOST_WIDTH,
        minHeight: GHOST_MIN_HEIGHT,
        boxSizing: 'border-box',
        // Mirrors the canvas NoteCard shell so the ghost reads as the card it
        // previews (white literal fill — `--bg-0` is the canvas background — with
        // a dashed accent border). Dimmed off-canvas to signal "not here".
        background: '#FFFFFF',
        border: '1px dashed var(--accent)',
        borderRadius: 'var(--r-3)',
        boxShadow: 'var(--shadow-2)',
        opacity: pos.overCanvas ? 0.7 : 0.4,
        padding: '12px 14px 10px',
        fontFamily: 'var(--font-sans)',
        fontSize: 14,
        color: 'var(--fg-1)',
        pointerEvents: 'none',
        zIndex: 900,
      }}
    >
      {title}
      {!pos.overCanvas && (
        <div style={{ marginTop: 8, fontSize: 11, fontStyle: 'italic', color: 'var(--fg-2)' }}>
          release over the canvas to drop
        </div>
      )}
    </div>,
    document.body,
  )
}
