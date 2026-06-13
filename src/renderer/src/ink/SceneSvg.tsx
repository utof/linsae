/**
 * Presentational renderer for an ink `Scene` as an inline SVG.
 *
 * Shared by the editor (interactive, with pointer handlers) and the Rail read-only overlay
 * (inert, no handlers → `pointer-events:none` so the overlay never swallows clicks meant
 * for the frame beneath).
 *
 * **Why always inline React SVG (never `<img>` of the sidecar):**
 * 1. **Interactivity** — an SVG loaded as an `<img>` is inert; its elements cannot receive
 *    pointer events, so an editor requires inline SVG regardless.
 * 2. **XSS boundary** — stored markup is never injected; the scene is reconstructed from
 *    `data-*` via `parseScene` and rendered here from typed data.
 * 3. **Crispness** — inline strokes re-tessellate via `getStroke` at the rendered size
 *    instead of scaling a fixed raster.
 *
 * `preserveAspectRatio="xMidYMid meet"` matches the base image's `objectFit:'contain'` so
 * the overlay aligns with the letterboxed image at any container size.
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Presentational renderer"
 * @see adrs/0026-overlay-render-inline-svg.md
 */
import type React from 'react'
import { strokeToPath } from './stroke'
import type { Scene, TextBlock } from './types'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SceneSvgProps {
  scene: Scene
  /**
   * Per-element pointer-down handler. When omitted the root SVG is inert
   * (`pointer-events:none`). Supplied by the editor; omitted by the Rail.
   */
  onElementPointerDown?: (id: string, e: React.PointerEvent) => void
  /**
   * Per-element pointer-enter handler. When omitted the root SVG is inert.
   * Used by the eraser tool to remove strokes on hover while button held.
   */
  onElementPointerEnter?: (id: string, e: React.PointerEvent) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a `Scene` as an inline SVG with one `<path>` per stroke and one
 * `<foreignObject>` per text block.
 *
 * When neither `onElementPointerDown` nor `onElementPointerEnter` is supplied,
 * the root SVG receives `pointer-events:none` so it is fully inert (Rail mode).
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Presentational renderer — SceneSvg"
 */
export function SceneSvg({
  scene,
  onElementPointerDown,
  onElementPointerEnter,
}: SceneSvgProps): React.JSX.Element {
  const hasHandlers = onElementPointerDown != null || onElementPointerEnter != null

  return (
    <svg
      viewBox={`0 0 ${scene.width} ${scene.height}`}
      preserveAspectRatio="xMidYMid meet"
      style={hasHandlers ? undefined : { pointerEvents: 'none' }}
      // aria-hidden when inert (decorative overlay); aria-label when interactive (editor).
      // Why: biome a11y/noSvgWithoutTitle requires accessible labeling on SVG elements.
      aria-hidden={!hasHandlers}
      aria-label={hasHandlers ? 'Annotation overlay' : undefined}
    >
      {scene.elements.map((el) => {
        if (el.kind === 'stroke') {
          const d = strokeToPath(el)
          return (
            <path
              key={el.id}
              d={d}
              fill={el.color}
              onPointerDown={
                onElementPointerDown ? (e) => onElementPointerDown(el.id, e) : undefined
              }
              onPointerEnter={
                onElementPointerEnter ? (e) => onElementPointerEnter(el.id, e) : undefined
              }
            />
          )
        }
        // el.kind === 'text'
        // exactOptionalPropertyTypes: only spread handlers when they are defined (not undefined).
        return (
          <SceneTextBlock
            key={el.id}
            el={el}
            {...(onElementPointerDown != null && { onPointerDown: onElementPointerDown })}
            {...(onElementPointerEnter != null && { onPointerEnter: onElementPointerEnter })}
          />
        )
      })}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Private sub-component for text blocks
// ---------------------------------------------------------------------------

/**
 * Renders a single `TextBlock` as a `<foreignObject>` containing an HTML `<div>`.
 * The `height` from the scene is used for the foreignObject's height; the editor
 * re-measures and updates it when the block is rendered/edited.
 * Why sub-component: keeps the main map loop readable; foreignObject needs xmlns.
 */
function SceneTextBlock({
  el,
  onPointerDown,
  onPointerEnter,
}: {
  el: TextBlock
  onPointerDown?: (id: string, e: React.PointerEvent) => void
  onPointerEnter?: (id: string, e: React.PointerEvent) => void
}): React.JSX.Element {
  // Use at least 1px height so foreignObject is not zero-height (would be invisible)
  const h = Number.isFinite(el.height) && el.height > 0 ? el.height : 1

  return (
    <foreignObject
      x={el.x}
      y={el.y}
      width={el.width}
      height={h}
      onPointerDown={onPointerDown ? (e) => onPointerDown(el.id, e) : undefined}
      onPointerEnter={onPointerEnter ? (e) => onPointerEnter(el.id, e) : undefined}
    >
      {/* xmlns required so the div is parsed as HTML inside SVG foreignObject */}
      <div
        // @ts-expect-error -- xmlns prop is required for SVG foreignObject HTML content but not in React's HTMLAttributes
        xmlns="http://www.w3.org/1999/xhtml"
        style={{
          color: el.color,
          fontSize: `${el.fontSize}px`,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {el.text}
      </div>
    </foreignObject>
  )
}
