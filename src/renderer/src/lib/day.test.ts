// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { dayKey, formatDayLabel } from './day'

// Fixed reference points (local time). Using explicit Y/M/D constructors keeps
// these independent of the runner's timezone for the day-grouping assertions.
const NOON_JUN_3_2026 = new Date(2026, 5, 3, 12, 0, 0).getTime()
const LATE_JUN_3_2026 = new Date(2026, 5, 3, 23, 30, 0).getTime()
const EARLY_JUN_4_2026 = new Date(2026, 5, 4, 0, 30, 0).getTime()
const JUN_2_2026 = new Date(2026, 5, 2, 9, 0, 0).getTime()
const JUN_2_2024 = new Date(2024, 5, 2, 9, 0, 0).getTime()

describe('dayKey', () => {
  it('two times on the same local day share a key', () => {
    expect(dayKey(NOON_JUN_3_2026)).toBe(dayKey(LATE_JUN_3_2026))
  })

  it('11:30pm and 12:30am (next day) get different keys', () => {
    expect(dayKey(LATE_JUN_3_2026)).not.toBe(dayKey(EARLY_JUN_4_2026))
  })
})

describe('formatDayLabel', () => {
  it("same day → 'today'", () => {
    expect(formatDayLabel(NOON_JUN_3_2026, LATE_JUN_3_2026)).toBe('today')
  })

  it("previous day → 'yesterday'", () => {
    expect(formatDayLabel(JUN_2_2026, NOON_JUN_3_2026)).toBe('yesterday')
  })

  it('older same-year day → month + day, no year', () => {
    // now = Jun 4 so Jun 2 is two days back (not today/yesterday).
    expect(formatDayLabel(JUN_2_2026, EARLY_JUN_4_2026)).toBe('June 2')
  })

  it('different year → month + day + year', () => {
    expect(formatDayLabel(JUN_2_2024, NOON_JUN_3_2026)).toBe('June 2, 2024')
  })
})
