/**
 * Pane registry — the §10 dock-shell embryo. Data-driven from day one so the
 * full dock-shell milestone (vision §Dock shell) grows it without a rewrite.
 * @see docs/specs/v0.4-canvas-mvp.md §10
 */
import { describe, expect, it } from 'vitest'
import { getPane, PANES } from './Pane'

describe('Pane registry', () => {
  it('registers exactly one pane in v0.4 (Shelf, home left)', () => {
    expect(PANES).toHaveLength(1)
    expect(PANES[0]?.id).toBe('shelf')
    expect(PANES[0]?.homeDock).toBe('left')
  })
  it('getPane resolves by id', () => {
    expect(getPane('shelf')?.title).toBeTypeOf('string')
    expect(getPane('nope')).toBeUndefined()
  })
})
