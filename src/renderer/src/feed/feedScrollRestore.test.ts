// @vitest-environment node
import { expect, it } from 'vitest'
import { pickFeedRestore } from './feedScrollRestore'

const S = (keys: string[]) =>
  keys.map((key, index) => ({ key, index, start: 0, end: 0, size: 0, lane: 0 }))

it('indices match → primary (seed)', () => {
  const r = pickFeedRestore(
    { snapshot: S(['a', 'b']), offset: 120, anchor: { key: 'b', delta: 4, atEnd: false } },
    ['a', 'b', 'c'],
  )
  expect(r).toEqual({
    mode: 'seed',
    initialMeasurementsCache: expect.any(Array),
    initialOffset: 120,
  })
})
it('atEnd → bottom', () => {
  const r = pickFeedRestore(
    { snapshot: S(['a']), offset: 9, anchor: { key: 'a', delta: 0, atEnd: true } },
    ['x', 'a'],
  )
  expect(r.mode).toBe('bottom')
})
it('indices changed but anchor present → scrollToIndex', () => {
  const r = pickFeedRestore(
    { snapshot: S(['a', 'b']), offset: 9, anchor: { key: 'b', delta: 0, atEnd: false } },
    ['z', 'a', 'b'],
  )
  expect(r).toEqual({ mode: 'index', index: 2 })
})
it('anchor gone → default', () => {
  const r = pickFeedRestore(
    { snapshot: S(['a']), offset: 9, anchor: { key: 'a', delta: 0, atEnd: false } },
    ['x', 'y'],
  )
  expect(r.mode).toBe('default')
})
it('null restore → default', () => {
  expect(pickFeedRestore(null, ['a']).mode).toBe('default')
})
