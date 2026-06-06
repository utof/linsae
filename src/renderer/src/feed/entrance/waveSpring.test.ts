// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { springStep } from './waveSpring'

describe('springStep', () => {
  it('moves the offset toward 0 with negative velocity', () => {
    const next = springStep({ off: 50, vel: 0 }, 16, 180, 18)
    expect(next.off).toBeLessThan(50)
    expect(next.off).toBeGreaterThan(0)
    expect(next.vel).toBeLessThan(0)
  })
  it('converges to ~0 over time', () => {
    let s = { off: 50, vel: 0 }
    for (let i = 0; i < 200; i++) s = springStep(s, 16, 180, 18)
    expect(Math.abs(s.off)).toBeLessThan(0.5)
    expect(Math.abs(s.vel)).toBeLessThan(0.5)
  })
  it('clamps a large dt to avoid blow-up', () => {
    const next = springStep({ off: 50, vel: 0 }, 1000, 180, 18) // 1s frame
    expect(Number.isFinite(next.off)).toBe(true)
  })
})
