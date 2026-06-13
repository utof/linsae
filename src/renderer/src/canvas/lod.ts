/**
 * Single source of LOD-tier truth (spec §12). v0.4 builds renderers for
 * 'card' only; 'title'/'dot' are the semantic-zoom milestone's. Invariant
 * recorded there: anything visible at a tier persists at all deeper tiers.
 * @see docs/specs/v0.4-canvas-mvp.md §12
 * @see docs/canvas-vision.md §Semantic zoom
 */
export type LodTier = 'card' | 'title' | 'dot'

export const TIER_THRESHOLDS = { title: 0.5, dot: 0.15 } as const

/** Tier for a zoom level: zoom < 0.15 → dot, < 0.5 → title, else card. */
export function tierForZoom(zoom: number): LodTier {
  if (zoom < TIER_THRESHOLDS.dot) return 'dot'
  if (zoom < TIER_THRESHOLDS.title) return 'title'
  return 'card'
}
