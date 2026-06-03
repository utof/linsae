// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { formatTimeOnly } from './wallclock'

const T = new Date(2026, 5, 3, 14, 23, 0).getTime() // 2:23 PM / 14:23

describe('formatTimeOnly', () => {
  it('12h mode → time with AM/PM and never a date', () => {
    const s = formatTimeOnly(T, true)
    expect(s).toMatch(/2:23/)
    expect(s).toMatch(/PM/i)
    expect(s).not.toMatch(/Jun|2026/)
  })

  it('24h mode → 24-hour time, no AM/PM', () => {
    const s = formatTimeOnly(T, false)
    expect(s).toMatch(/14:23/)
    expect(s).not.toMatch(/[AP]M/i)
  })
})
