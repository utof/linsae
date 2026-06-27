/**
 * Pane registry — the §10 dock-shell embryo. Data-driven from day one so the
 * full dock-shell milestone (vision §Dock shell) grows it without a rewrite.
 * @see docs/specs/v0.4-canvas-mvp.md §10
 */
import { describe, expect, it } from 'vitest'
import { getPane, PANES } from './Pane'

describe('Pane registry', () => {
  it('registers the Shelf (home left) and the v0.6 PDF reader (home right, content)', () => {
    expect(PANES).toHaveLength(2)
    expect(getPane('shelf')?.homeDock).toBe('left')
    expect(getPane('pdf')?.homeDock).toBe('right')
    expect(getPane('pdf')?.kind).toBe('content')
  })
  it('getPane resolves by id', () => {
    expect(getPane('shelf')?.title).toBeTypeOf('string')
    expect(getPane('nope')).toBeUndefined()
  })
})
