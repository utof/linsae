// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { formatWallClock } from './wallclock'

const NOW = new Date(2026, 5, 3, 12, 0, 0).getTime()
const SAME_DAY = new Date(2026, 5, 3, 14, 23, 0).getTime()
const OLDER = new Date(2026, 4, 27, 14, 23, 0).getTime()

describe('formatWallClock', () => {
  it('same day → time only, no month', () => {
    const s = formatWallClock(SAME_DAY, true, NOW)
    expect(s).toMatch(/2:23/)
    expect(s).not.toMatch(/May|Jun/)
  })

  it('24h mode drops the AM/PM suffix', () => {
    const s = formatWallClock(SAME_DAY, false, NOW)
    expect(s).toMatch(/14:23/)
    expect(s).not.toMatch(/[AP]M/i)
  })

  it('older day → carries the month + day', () => {
    expect(formatWallClock(OLDER, true, NOW)).toMatch(/May 27/)
  })
})
