// src/renderer/src/panes/dock-widths.test.ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { clampWidth, DOCK_WIDTH, defaultWidthFor, maxDockWidth } from './dock-widths'

describe('dock-widths', () => {
  it('clamps to the utility band (220–400)', () => {
    expect(clampWidth('utility', 100)).toBe(220)
    expect(clampWidth('utility', 300)).toBe(300)
    expect(clampWidth('utility', 999)).toBe(400)
  })
  it('clamps to the content band (400–900)', () => {
    expect(clampWidth('content', 100)).toBe(400)
    expect(clampWidth('content', 600)).toBe(600)
    expect(clampWidth('content', 9999)).toBe(900)
  })
  it('defaults: utility 280, content 600', () => {
    expect(defaultWidthFor('utility')).toBe(280)
    expect(defaultWidthFor('content')).toBe(600)
    expect(DOCK_WIDTH.content.max).toBe(900)
  })

  // B14 / ADR 0047: the dock resize cap keeps the feed ≥ FEED_BAND.min (360) and
  // the docks from ever overlapping the feed.
  describe('maxDockWidth', () => {
    it('a wide window does not bind: cap is the kind max', () => {
      expect(maxDockWidth('content', 0, 2000)).toBe(900) // 2000-360 = 1640 > 900
      expect(maxDockWidth('utility', 0, 2000)).toBe(400)
    })
    it('a narrower window caps below the kind max so the feed keeps its min', () => {
      // 1200 - 360(feedMin) - 0 = 840 < 900 → cap 840; feed = 1200-840 = 360 = min.
      expect(maxDockWidth('content', 0, 1200)).toBe(840)
    })
    it('accounts for the other dock width (combined cap, any pane count)', () => {
      // left shelf 280 open → right cap = 1400 - 360 - 280 = 760.
      expect(maxDockWidth('content', 280, 1400)).toBe(760)
    })
    it('floors at the kind min on a pathologically narrow window (feed yields, dock stays usable)', () => {
      // room = 600-360 = 240 < content min 400 → stays at 400 (no overlap; the feed,
      // which has no CSS min-width, shrinks past its nominal min instead).
      expect(maxDockWidth('content', 0, 600)).toBe(400)
    })
  })
})
