// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { frecencyScore } from './recency'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const now = 1_000_000_000_000

describe('frecencyScore (zoxide buckets)', () => {
  it('<1h → frequency × 4', () => {
    expect(frecencyScore(3, now - 30 * 60_000, now)).toBe(12)
  })
  it('<1d → frequency × 2', () => {
    expect(frecencyScore(3, now - 5 * HOUR, now)).toBe(6)
  })
  it('<1w → frequency × 0.5', () => {
    expect(frecencyScore(4, now - 3 * DAY, now)).toBe(2)
  })
  it('else → frequency × 0.25', () => {
    expect(frecencyScore(4, now - 2 * WEEK, now)).toBe(1)
  })
  it('boundaries: exactly 1h falls into the <1d bucket', () => {
    expect(frecencyScore(1, now - HOUR, now)).toBe(2) // age === 1h is NOT < 1h
  })
  it('higher frequency outranks fresher-but-rarer for the same bucket', () => {
    expect(frecencyScore(10, now - 10 * HOUR, now)).toBeGreaterThan(
      frecencyScore(1, now - HOUR, now),
    )
  })
})
