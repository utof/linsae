/**
 * Scene model for the ink module — context-free, imports only DOM/React.
 *
 * A single ordered `elements` array preserves z-order (draw order = paint order);
 * the eraser removes by `id`.
 *
 * Why context-free: this module is the seam for the future spatial-canvas roadmap.
 * It must be consumable by any host (screenshot editor, canvas, test) without pulling
 * in Electron IPC, attachment, or thread concerns.
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"The ink module"
 * @see adrs/0027-context-free-ink-module.md
 */

/** A single raw input point in image-pixel space (NOT an outline point). */
export interface InkPoint {
  x: number
  y: number
  /** Normalized 0–1 pressure from PointerEvent; fallback 0.5 for mouse/touch. */
  pressure: number
}

/**
 * A pressure-sensitive freehand stroke.
 * Points are the raw input (NOT the outline) so they can be re-tessellated.
 * @see adrs/0025-drawing-overlay-format.md
 */
export interface Stroke {
  /** Minted by the editor via crypto.randomUUID(); stable across edits. Used by eraser. */
  id: string
  kind: 'stroke'
  /** Raw input points in image-pixel space — re-tessellatable at any render size. */
  points: InkPoint[]
  /** CSS color (a swatch value, e.g. a hex or CSS variable). */
  color: string
  /** perfect-freehand `size` in image-pixel space. */
  size: number
  /**
   * When false, getStroke uses the recorded per-point pressure (stylus).
   * When true, getStroke derives pressure from velocity and IGNORES recorded pressure
   * (correct for mouse/touch which have no real pressure).
   * CRITICAL: getStroke defaults simulatePressure to true, so a stylus's real pressure
   * is silently ignored unless this is explicitly false.
   * @see ink/stroke.ts#strokeToPath
   */
  simulatePressure: boolean
}

/**
 * A positioned text overlay block.
 * `height` is the measured rendered height; serialized as a numeric value,
 * re-measured when the editor reopens (never `auto` — that renders zero-height).
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Scene model"
 */
export interface TextBlock {
  /** Minted by the editor via crypto.randomUUID(). Used by eraser/move. */
  id: string
  kind: 'text'
  /** Top-left x in image-pixel space. */
  x: number
  /** Top-left y in image-pixel space. */
  y: number
  /** Wrap width in image-pixel space. */
  width: number
  /**
   * Measured rendered height in px. Serialized as a numeric value for standalone
   * SVG fidelity; re-measured on editor reopen rather than trusted from storage.
   */
  height: number
  text: string
  /** CSS color (a swatch value). */
  color: string
  /** Font size in image-pixel space. */
  fontSize: number
}

/** Discriminated union of all element types the scene can hold. */
export type SceneElement = Stroke | TextBlock

/**
 * The complete annotation scene for one screenshot frame.
 * `width`/`height` correspond to `attachment.width_px`/`height_px` and define the
 * SVG `viewBox` coordinate space.
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Data model"
 */
export interface Scene {
  /** = attachment.width_px — the SVG viewBox width in image pixels. */
  width: number
  /** = attachment.height_px — the SVG viewBox height in image pixels. */
  height: number
  /** Ordered array of elements; draw/paint order = array order. */
  elements: SceneElement[]
}
