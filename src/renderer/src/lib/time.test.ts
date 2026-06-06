import { describe, expect, it } from 'vitest'
import { clampSeconds, formatClock, parseClock, parseTimeDigits } from './time'

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

describe('parseTimeDigits', () => {
  it('reads digits right-to-left (ss, mm, hh)', () => {
    expect(parseTimeDigits('5')).toBe(5)
    expect(parseTimeDigits('123')).toBe(83) // 1:23
    expect(parseTimeDigits('1234')).toBe(12 * 60 + 34) // 12:34
    expect(parseTimeDigits('12345')).toBe(3600 + 23 * 60 + 45) // 1:23:45
  })
  it('strips non-digits and handles empty', () => {
    expect(parseTimeDigits('')).toBe(0)
    expect(parseTimeDigits('12:34')).toBe(12 * 60 + 34) // colon stripped → same as 1234
    expect(parseTimeDigits('abc')).toBe(0)
  })
  it('round-trips through formatClock', () => {
    expect(formatClock(parseTimeDigits('1234'))).toBe('12:34')
    expect(formatClock(parseTimeDigits('12345'))).toBe('1:23:45')
  })
})

describe('clampSeconds', () => {
  it('clamps to the duration ceiling', () => {
    expect(clampSeconds(540, 501)).toBe(501) // 9:00 entered, 8:21 video → 8:21
    expect(clampSeconds(100, 501)).toBe(100) // within range, untouched
  })
  it('floors at 0 and ignores null/≤0 max', () => {
    expect(clampSeconds(-5, 501)).toBe(0)
    expect(clampSeconds(540, null)).toBe(540)
    expect(clampSeconds(540, 0)).toBe(540)
  })
})
