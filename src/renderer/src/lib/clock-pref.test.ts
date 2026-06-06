import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { isClock24, setClock24, useClock24 } from './clock-pref'

afterEach(() => {
  localStorage.clear()
})

describe('clock-pref', () => {
  it('defaults to 12-hour (false) when unset', () => {
    expect(isClock24()).toBe(false)
  })

  it('round-trips through localStorage', () => {
    setClock24(true)
    expect(isClock24()).toBe(true)
    setClock24(false)
    expect(isClock24()).toBe(false)
  })

  it('useClock24 reacts to a setClock24 write', () => {
    const { result } = renderHook(() => useClock24())
    expect(result.current).toBe(false)
    act(() => setClock24(true))
    expect(result.current).toBe(true)
    act(() => setClock24(false))
    expect(result.current).toBe(false)
  })
})
