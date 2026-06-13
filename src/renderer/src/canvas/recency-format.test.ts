/**
 * Recent-popover label formatting (spec §14). Pure: (kind, at, now) → string.
 * @see docs/specs/v0.4-canvas-mvp.md §14
 */
import { describe, expect, it } from 'vitest'
import { recentLabel } from './recency-format'

const NOW = 1_700_000_000_000

describe('recentLabel', () => {
  it('prefixes by kind and renders a relative age', () => {
    expect(recentLabel({ noteId: 'a', kind: 'created', at: NOW - 60_000 }, NOW)).toBe(
      'created here · 1m',
    )
    expect(recentLabel({ noteId: 'a', kind: 'edited', at: NOW - 120_000 }, NOW)).toBe('edited · 2m')
    expect(recentLabel({ noteId: 'a', kind: 'placed', at: NOW - 3_600_000 }, NOW)).toBe(
      'placed · 1h',
    )
  })
  it('uses "now" under a minute and day granularity past 24h', () => {
    expect(recentLabel({ noteId: 'a', kind: 'edited', at: NOW - 5_000 }, NOW)).toBe('edited · now')
    expect(recentLabel({ noteId: 'a', kind: 'placed', at: NOW - 90_000_000 }, NOW)).toBe(
      'placed · 1d',
    )
  })
})
