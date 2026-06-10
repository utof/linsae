import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_WAVE_TUNING,
  getWaveTuning,
  resetWaveTuning,
  seedOffset,
  setWaveTuning,
  useWaveTuning,
} from './wave-tuning'

afterEach(() => localStorage.clear())

describe('wave-tuning', () => {
  it('defaults reproduce the shipped wave (no floor, unit multiplier)', () => {
    expect(getWaveTuning()).toEqual(DEFAULT_WAVE_TUNING)
    expect(DEFAULT_WAVE_TUNING.ampFloor).toBe(0)
    expect(DEFAULT_WAVE_TUNING.ampMult).toBe(1)
  })

  describe('seedOffset', () => {
    it('is exactly the note height with the defaults', () => {
      expect(seedOffset(40, DEFAULT_WAVE_TUNING)).toBe(40)
      expect(seedOffset(400, DEFAULT_WAVE_TUNING)).toBe(400)
    })
    it('lifts a SHORT note to the floor but leaves a tall note alone', () => {
      const t = { ...DEFAULT_WAVE_TUNING, ampFloor: 120 }
      expect(seedOffset(40, t)).toBe(120) // short → floored up
      expect(seedOffset(300, t)).toBe(300) // tall → unchanged
    })
    it('scales by the multiplier; floor wins when larger', () => {
      expect(seedOffset(40, { ...DEFAULT_WAVE_TUNING, ampMult: 2 })).toBe(80)
      expect(seedOffset(40, { ...DEFAULT_WAVE_TUNING, ampMult: 2, ampFloor: 120 })).toBe(120)
    })
  })

  it('round-trips a partial override, merging over defaults', () => {
    setWaveTuning({ stiffness: 100, ampFloor: 140 })
    const t = getWaveTuning()
    expect(t.stiffness).toBe(100)
    expect(t.ampFloor).toBe(140)
    expect(t.damping).toBe(DEFAULT_WAVE_TUNING.damping) // untouched key stays default
  })

  it('ignores non-numeric / unknown stored values', () => {
    localStorage.setItem('linsae.waveTuning', JSON.stringify({ stiffness: 'nope', bogus: 5 }))
    expect(getWaveTuning()).toEqual(DEFAULT_WAVE_TUNING)
  })

  it('reset clears overrides', () => {
    setWaveTuning({ ampFloor: 200 })
    expect(getWaveTuning().ampFloor).toBe(200)
    resetWaveTuning()
    expect(getWaveTuning()).toEqual(DEFAULT_WAVE_TUNING)
  })

  it('useWaveTuning re-renders on change', () => {
    const { result } = renderHook(() => useWaveTuning())
    expect(result.current.ampFloor).toBe(0)
    act(() => setWaveTuning({ ampFloor: 160 }))
    expect(result.current.ampFloor).toBe(160)
  })
})
