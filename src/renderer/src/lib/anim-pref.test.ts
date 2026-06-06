import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { getFeedEntrance, setFeedEntrance, useFeedEntrance } from './anim-pref'

afterEach(() => localStorage.clear())

describe('anim-pref', () => {
  it('defaults to glide when unset', () => {
    expect(getFeedEntrance()).toBe('glide')
  })
  it('round-trips a set value', () => {
    setFeedEntrance('pbd')
    expect(getFeedEntrance()).toBe('pbd')
  })
  it('falls back to glide for an unknown stored value', () => {
    localStorage.setItem('linsae.feedEntrance', 'bogus')
    expect(getFeedEntrance()).toBe('glide')
  })
  it('useFeedEntrance re-renders on change', () => {
    const { result } = renderHook(() => useFeedEntrance())
    expect(result.current).toBe('glide')
    act(() => setFeedEntrance('flip'))
    expect(result.current).toBe('flip')
  })
})
