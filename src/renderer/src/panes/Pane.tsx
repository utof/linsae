import type { ReactNode } from 'react'
import { BacklinksPaneBody } from '../backlinks/BacklinksPaneBody'
import { PdfReader } from '../pdf/PdfReader'
import { PlayerPane } from '../yt/PlayerPane'
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
  /**
   * Whether this pane holds primary content (a PDF reader, a doc) or a utility
   * sidebar (the Shelf). Drives the dock's width clamp: `content` panes get a
   * wider 400–900 px band, `utility` panes the original 220–400 px (see Dock).
   * Optional + defaults to `'utility'` so v0.4 pane registrations stay valid.
   * @see docs/plans/v0.6-pdf-slim-slice.md §Task 7
   */
  kind?: 'utility' | 'content'
  render: () => ReactNode
}

/** The pane registry — the v0.4 Shelf, the v0.6 PDF reader (home right), the
 *  v0.6.2 backlinks utility pane (home right; tabs with PDF), and the v0.6.4
 *  YouTube player content pane (home right; mirrors the PDF pane's kind/dock).
 *  @see docs/specs/v0.6.2-dock-shell.md §2
 *  @see docs/plans/v0.6.4-notes-as-threads.md §Task 5.1 (B5) */
export const PANES: Pane[] = [
  { id: 'shelf', title: 'shelf', homeDock: 'left', render: () => <ShelfPaneBody /> },
  { id: 'pdf', title: 'pdf', homeDock: 'right', kind: 'content', render: () => <PdfReader /> },
  {
    id: 'backlinks',
    title: 'backlinks',
    homeDock: 'right',
    kind: 'utility',
    render: () => <BacklinksPaneBody />,
  },
  {
    id: 'player',
    title: 'player',
    homeDock: 'right',
    kind: 'content',
    render: () => <PlayerPane />,
  },
]

/** Resolve a pane by id (undefined if unknown). */
export function getPane(id: string): Pane | undefined {
  return PANES.find((p) => p.id === id)
}
