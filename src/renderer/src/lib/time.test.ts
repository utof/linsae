import { describe, expect, it } from 'vitest'
import { formatClock, parseClock } from './time'

describe('formatClock', () => {
  it('formats < 1h as m:ss', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(83)).toBe('1:23')
    expect(formatClock(599)).toBe('9:59')
  })
  it('formats >= 1h as h:mm:ss', () => {
    expect(formatClock(3723)).toBe('1:02:03')
  })
  it('floors fractional seconds', () => {
    expect(formatClock(83.9)).toBe('1:23')
  })
})

describe('parseClock', () => {
  it('parses m:ss and h:mm:ss', () => {
    expect(parseClock('1:23')).toBe(83)
    expect(parseClock('1:02:03')).toBe(3723)
  })
  it('returns null for garbage', () => {
    expect(parseClock('')).toBeNull()
    expect(parseClock('abc')).toBeNull()
    expect(parseClock('1:99')).toBeNull() // seconds must be 00-59
  })
})
