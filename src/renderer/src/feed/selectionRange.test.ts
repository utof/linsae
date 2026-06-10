// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { fillToIndex, indicesInRange } from './selectionRange'

// Three stacked rows: [0,82) [82,130) [130,178)
const rows = [
  { index: 0, start: 0, end: 82 },
  { index: 1, start: 82, end: 130 },
  { index: 2, start: 130, end: 178 },
]

describe('indicesInRange', () => {
  it('returns rows the y-range overlaps', () => {
    expect(indicesInRange(rows, 10, 140)).toEqual([0, 1, 2])
  })
  it('is direction-agnostic (drag upward)', () => {
    expect(indicesInRange(rows, 140, 10)).toEqual([0, 1, 2])
  })
  it('excludes rows the range only touches at the boundary', () => {
    // range bottom == row 1 start → no overlap (half-open semantics)
    expect(indicesInRange(rows, 0, 82)).toEqual([0])
    // range top == row 0 end → row 0 excluded
    expect(indicesInRange(rows, 82, 100)).toEqual([1])
  })
  it('selects the row containing a zero-height range', () => {
    expect(indicesInRange(rows, 90, 90)).toEqual([1])
  })
  it('returns empty for empty rows', () => {
    expect(indicesInRange([], 0, 100)).toEqual([])
  })
})

describe('fillToIndex', () => {
  it('fills from the nearest selected index to the target, inclusive', () => {
    expect(fillToIndex([0], 3)).toEqual([0, 1, 2, 3])
    expect(fillToIndex([5], 2)).toEqual([2, 3, 4, 5])
  })
  it('uses the nearest of several selected indices', () => {
    expect(fillToIndex([0, 10], 7)).toEqual([7, 8, 9, 10])
  })
  it('returns just the target when nothing is selected', () => {
    expect(fillToIndex([], 4)).toEqual([4])
  })
})
