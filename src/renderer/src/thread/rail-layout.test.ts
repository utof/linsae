import { describe, expect, it } from 'vitest'
import {
  clusterByPause,
  jumpPillVisible,
  logGapHeight,
  markerPositions,
  partitionAnchorless,
  sortForMode,
} from './rail-layout'

const n = (id: string, t: number | null, createdAt = 0) => ({ id, t, createdAt })

describe('logGapHeight', () => {
  it('is round(20 + 9·ln(1+minutes))', () => {
    expect(logGapHeight(0)).toBe(20)
    expect(logGapHeight(1)).toBe(Math.round(20 + 9 * Math.log(2))) // 26
    expect(logGapHeight(60)).toBe(Math.round(20 + 9 * Math.log(61))) // ~57
  })
})

describe('partitionAnchorless', () => {
  it('splits anchored (t != null) from anchorless (t == null)', () => {
    const { anchored, anchorless } = partitionAnchorless([n('a', 5), n('b', null), n('c', 1)])
    expect(anchored.map((x) => x.id)).toEqual(['a', 'c'])
    expect(anchorless.map((x) => x.id)).toEqual(['b'])
  })
})

describe('clusterByPause', () => {
  it('groups consecutive same-second anchors into one cluster (sorted by t)', () => {
    const clusters = clusterByPause([n('a', 83), n('b', 83), n('c', 90)])
    expect(clusters).toHaveLength(2)
    const [c0, c1] = clusters
    expect(c0?.t).toBe(83)
    expect(c0?.notes.map((x) => x.id)).toEqual(['a', 'b'])
    expect(c1?.t).toBe(90)
  })
})

describe('sortForMode', () => {
  it('video mode sorts anchored by t asc, anchorless last by createdAt', () => {
    const out = sortForMode([n('a', 90, 2), n('b', null, 1), n('c', 5, 3)], 'video')
    expect(out.map((x) => x.id)).toEqual(['c', 'a', 'b'])
  })
  it('capture mode sorts all by createdAt asc', () => {
    const out = sortForMode([n('a', 90, 30), n('b', null, 10), n('c', 5, 20)], 'capture')
    expect(out.map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('markerPositions', () => {
  it('maps unique anchors to percent of duration', () => {
    expect(markerPositions([n('a', 30), n('b', 30), n('c', 90)], 300)).toEqual([
      { t: 30, pct: 10 },
      { t: 90, pct: 30 },
    ])
  })
  it('is empty when duration is unknown', () => {
    expect(markerPositions([n('a', 30)], null)).toEqual([])
  })
  it('is empty for a non-positive duration', () => {
    expect(markerPositions([n('a', 30)], 0)).toEqual([])
    expect(markerPositions([n('a', 30)], -1)).toEqual([])
  })
})

describe('jumpPillVisible', () => {
  it('shows only in video mode, follow off, playhead off-screen', () => {
    expect(
      jumpPillVisible({
        mode: 'video',
        followOn: false,
        playheadY: -10,
        viewTop: 0,
        viewBottom: 500,
      }),
    ).toBe(true)
    expect(
      jumpPillVisible({
        mode: 'video',
        followOn: false,
        playheadY: 600,
        viewTop: 0,
        viewBottom: 500,
      }),
    ).toBe(true)
    expect(
      jumpPillVisible({
        mode: 'video',
        followOn: false,
        playheadY: 250,
        viewTop: 0,
        viewBottom: 500,
      }),
    ).toBe(false)
    expect(
      jumpPillVisible({
        mode: 'video',
        followOn: true,
        playheadY: -10,
        viewTop: 0,
        viewBottom: 500,
      }),
    ).toBe(false)
    expect(
      jumpPillVisible({
        mode: 'capture',
        followOn: false,
        playheadY: -10,
        viewTop: 0,
        viewBottom: 500,
      }),
    ).toBe(false)
  })

  it('uses a strict 8px threshold (boundary exactly at the edge is hidden)', () => {
    const base = { mode: 'video' as const, followOn: false, viewTop: 0, viewBottom: 500 }
    // viewTop + 8 = 8, viewBottom - 8 = 492
    expect(jumpPillVisible({ ...base, playheadY: 7 })).toBe(true)
    expect(jumpPillVisible({ ...base, playheadY: 8 })).toBe(false)
    expect(jumpPillVisible({ ...base, playheadY: 492 })).toBe(false)
    expect(jumpPillVisible({ ...base, playheadY: 493 })).toBe(true)
  })
})
