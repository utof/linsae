// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { maxDockWidth } from '../panes/dock-widths'
import { computeFeedBand, FEED_BAND } from './feedBand'

/**
 * Model A (ADR 0047) feed-band geometry. The feed stays centered in the WINDOW
 * while docks fill the gutters; it shrinks toward FEED_BAND.min and slides flush
 * only once a dock is widened past its gutter. These cases pin each regime.
 */
describe('computeFeedBand', () => {
  it('returns null when no dock is open (caller uses the default centered layout)', () => {
    expect(computeFeedBand(1400, 0, 0)).toBeNull()
  })

  it('returns null before the width is measured (winW <= 0)', () => {
    expect(computeFeedBand(0, 280, 0)).toBeNull()
  })

  it('small right dock fits in the gutter: feed keeps default width, centered in window', () => {
    const band = computeFeedBand(1400, 0, 280)
    expect(band).not.toBeNull()
    if (!band) return
    expect(band.maxWidth).toBe(FEED_BAND.default) // 720, unshrunk
    // window-left edge = leftDock(0) + marginLeft must center the band: (1400-720)/2 = 340
    expect(band.marginLeft).toBe(340)
    // band centered in the window → window-center 700 = 340 + 720/2 ✓
    expect(band.marginLeft + band.maxWidth / 2).toBe(700)
    // a gutter still separates the band from the dock (not flush)
    expect(band.marginRight).toBeGreaterThan(0)
  })

  it('B3: small LEFT dock also keeps the feed centered in the window (no rightward push)', () => {
    const band = computeFeedBand(1400, 280, 0)
    expect(band).not.toBeNull()
    if (!band) return
    expect(band.maxWidth).toBe(FEED_BAND.default)
    // window-left edge = leftDock(280) + marginLeft(60) = 340; center 340 + 360 = 700 = winW/2
    expect(280 + band.marginLeft + band.maxWidth / 2).toBe(700)
    // gutter remains between the left dock and the band
    expect(band.marginLeft).toBeGreaterThan(0)
  })

  it('wide right dock encroaches: feed shrinks to fill the remaining space, flush against the dock', () => {
    const band = computeFeedBand(1400, 0, 900)
    expect(band).not.toBeNull()
    if (!band) return
    expect(band.maxWidth).toBe(500) // remaining = 1400 - 900
    expect(band.marginLeft).toBe(0) // flush to the window's left edge
    expect(band.marginRight).toBe(0) // flush against the right dock — no overlap
  })

  it('both docks open: feed fills the space between them with no overlap', () => {
    const band = computeFeedBand(1400, 280, 600)
    expect(band).not.toBeNull()
    if (!band) return
    expect(band.maxWidth).toBe(520) // remaining = 1400 - 280 - 600
    expect(band.marginLeft).toBe(0)
    expect(band.marginRight).toBe(0)
  })

  it('never drops below FEED_BAND.min even when a dock is enormous', () => {
    const band = computeFeedBand(900, 0, 800)
    expect(band).not.toBeNull()
    if (!band) return
    expect(band.maxWidth).toBe(FEED_BAND.min) // remaining 100 < min → floored at 360
  })

  // B14: feeding the EFFECTIVE (window-capped) dock width into computeFeedBand —
  // exactly what App does — must put the feed at its min with zero overlap, for one
  // OR two open docks. "No overlap" ⇒ marginLeft ≥ 0, marginRight ≥ 0, and
  // marginLeft + maxWidth + marginRight ≤ remaining (the band fits inside <main>).
  describe('with the dock cap applied (B14, end-to-end)', () => {
    const fits = (band: NonNullable<ReturnType<typeof computeFeedBand>>, remaining: number) => {
      expect(band.marginLeft).toBeGreaterThanOrEqual(0)
      expect(band.marginRight).toBeGreaterThanOrEqual(0)
      expect(band.marginLeft + band.maxWidth + band.marginRight).toBeLessThanOrEqual(remaining)
    }

    it('one dock dragged to its cap → feed exactly at min, no overlap', () => {
      const W = 1200
      const right = maxDockWidth('content', 0, W) // 840
      const band = computeFeedBand(W, 0, right)
      expect(band).not.toBeNull()
      if (!band) return
      expect(band.maxWidth).toBe(FEED_BAND.min) // feed sits exactly at 360
      fits(band, W - right)
    })

    it('both docks at their caps → combined cap still keeps feed ≥ min, no overlap', () => {
      const W = 1400
      const left = 280 // shelf default
      const right = maxDockWidth('content', left, W) // 760
      const band = computeFeedBand(W, left, right)
      expect(band).not.toBeNull()
      if (!band) return
      expect(band.maxWidth).toBeGreaterThanOrEqual(FEED_BAND.min)
      fits(band, W - left - right)
    })
  })
})
