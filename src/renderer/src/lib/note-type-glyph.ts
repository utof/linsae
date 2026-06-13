import type { NoteType } from '../../../shared/types'

/**
 * Single-char type signifiers shown at a glance in picker rows, shelf rows, and
 * anywhere a note's type needs a compact, dependency-free badge. ● (filled
 * circle) = neutral claim; ? = open question; ◆ = sourced locator.
 * Why a shared map (not per-component): the `/` picker (§5) and the shelf (§4)
 * both render type glyphs; a single source keeps them from drifting.
 * @see docs/specs/v0.4-canvas-mvp.md §5
 */
export const NOTE_TYPE_GLYPH: Record<NoteType, string> = {
  claim: '●',
  question: '?',
  source: '◆',
}

/**
 * v21 design-system color token per note type, mirroring the glyph map above.
 * @see src/renderer/src/styles/colors_and_type.css (--type-* tokens)
 */
export const NOTE_TYPE_COLOR: Record<NoteType, string> = {
  claim: 'var(--type-claim)',
  question: 'var(--type-question)',
  source: 'var(--type-source)',
}
