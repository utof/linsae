/**
 * Unit tests for composer-chip pure state functions.
 *
 * Four behavioural cases:
 *   1. live   — unfocused + empty: chipTime returns livePlayhead; nextFrozenAt tracks live.
 *   2. freeze — focus gained (focused:true, hasDraft:false): chip freezes at playhead; ignores advancing live.
 *   3. typing — focused + hasDraft: chipTime stays frozen; nextFrozenAt keeps previous.
 *   4. resume — focus lost + draft cleared (focused:false, hasDraft:false): live-tracking resumes.
 *
 * @see src/renderer/src/thread/composer-chip.ts
 * @see docs/specs/v0.2-youtube-annotation.md §Composer
 */

import { describe, expect, it } from 'vitest'
import { chipTime, nextFrozenAt } from './composer-chip'

describe('chipTime', () => {
  it('(1-live) returns livePlayhead when unfocused and empty', () => {
    expect(chipTime({ focused: false, hasDraft: false, livePlayhead: 42, frozenAt: 10 })).toBe(42)
  })

  it('(2-freeze) returns frozenAt when focused (ignores advancing live)', () => {
    // frozenAt=50, livePlayhead has advanced to 80 — chip must stay at 50
    expect(chipTime({ focused: true, hasDraft: false, livePlayhead: 80, frozenAt: 50 })).toBe(50)
  })

  it('(3-typing) returns frozenAt when focused with draft text', () => {
    expect(chipTime({ focused: true, hasDraft: true, livePlayhead: 90, frozenAt: 50 })).toBe(50)
  })

  it('(4-resume) returns livePlayhead again after blur + draft cleared', () => {
    expect(chipTime({ focused: false, hasDraft: false, livePlayhead: 75, frozenAt: 50 })).toBe(75)
  })
})

describe('nextFrozenAt', () => {
  it('(1-live) tracks live when unfocused+empty so next freeze captures a fresh value', () => {
    // After blur+clear, frozenAt should become livePlayhead so the NEXT focus
    // event captures the current position rather than a stale one.
    expect(nextFrozenAt(10, { focused: false, hasDraft: false, livePlayhead: 50 })).toBe(50)
  })

  it('(2-freeze) captures livePlayhead on focus gained (focused:true, hasDraft:false)', () => {
    // prev was 10 (stale); on focus we capture livePlayhead=50
    expect(nextFrozenAt(10, { focused: true, hasDraft: false, livePlayhead: 50 })).toBe(50)
  })

  it('(3-typing) keeps previous frozen value while typing (does NOT re-capture)', () => {
    // frozenAt was captured at 50; livePlayhead has since advanced to 80
    expect(nextFrozenAt(50, { focused: true, hasDraft: true, livePlayhead: 80 })).toBe(50)
  })

  it('(4-resume) resumes tracking live on blur+clear so next freeze is fresh', () => {
    // After the chip resumes, frozenAt should equal livePlayhead (75)
    expect(nextFrozenAt(50, { focused: false, hasDraft: false, livePlayhead: 75 })).toBe(75)
  })

  it('round-trip: focus → type → blur → focus captures fresh position', () => {
    // Simulate a complete user flow:
    //   • blur+empty at t=0 → frozenAt tracks 0
    //   • at t=30, user focuses → frozenAt=30
    //   • types text (hasDraft:true) → frozenAt stays 30, live advances to 60
    //   • Esc / clears (blur+empty) → frozenAt→60 (tracks live)
    //   • user focuses again at t=60 → frozenAt=60 (fresh, not stale 30)

    let f = nextFrozenAt(0, { focused: false, hasDraft: false, livePlayhead: 0 })
    // blur+empty: f=0

    f = nextFrozenAt(f, { focused: true, hasDraft: false, livePlayhead: 30 })
    // focus gained at 30: f=30
    expect(f).toBe(30)

    f = nextFrozenAt(f, { focused: true, hasDraft: true, livePlayhead: 60 })
    // typing, live advanced: f stays 30
    expect(f).toBe(30)

    f = nextFrozenAt(f, { focused: false, hasDraft: false, livePlayhead: 60 })
    // Esc/clear: f → 60
    expect(f).toBe(60)

    f = nextFrozenAt(f, { focused: true, hasDraft: false, livePlayhead: 60 })
    // re-focus at 60: fresh capture
    expect(f).toBe(60)
  })
})
