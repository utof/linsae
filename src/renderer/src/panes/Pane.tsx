import type { ReactNode } from 'react'
import { ShelfPaneBody } from './ShelfPane'

/**
 * A dockable pane (spec §10 — the dock-shell embryo). `render` is a thunk so a
 * pane only builds its subtree when its dock is open. v0.4 registers exactly
 * one (Shelf, home left) and renders one dock (left); the full grammar (right
 * dock, tab strips at ≥2 panes, tab dragging) is vision §Dock shell's milestone.
 * @see docs/specs/v0.4-canvas-mvp.md §10
 * @see docs/canvas-vision.md §Dock shell
 */
export interface Pane {
  id: string
  title: string
  homeDock: 'left' | 'right'
  render: () => ReactNode
}

/** The v0.4 pane registry — one entry. */
export const PANES: Pane[] = [
  { id: 'shelf', title: 'shelf', homeDock: 'left', render: () => <ShelfPaneBody /> },
]

/** Resolve a pane by id (undefined if unknown). */
export function getPane(id: string): Pane | undefined {
  return PANES.find((p) => p.id === id)
}
