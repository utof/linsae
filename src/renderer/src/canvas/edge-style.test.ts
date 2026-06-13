import { describe, expect, it } from 'vitest'
import { edgeKind, isDrawnEdge } from './edge-style'

describe('edgeKind', () => {
  it("'reference' → reference (read-only)", () => expect(edgeKind('reference')).toBe('reference'))
  it("'comment-on' → comment (read-only)", () => expect(edgeKind('comment-on')).toBe('comment'))
  it("'link' → drawn", () => expect(edgeKind('link')).toBe('drawn'))
  it('free-text label → drawn', () => expect(edgeKind('supports')).toBe('drawn'))
})
describe('isDrawnEdge', () => {
  it('drawn edges are interactive; reference/comment are not', () => {
    expect(isDrawnEdge('link')).toBe(true)
    expect(isDrawnEdge('supports')).toBe(true)
    expect(isDrawnEdge('reference')).toBe(false)
    expect(isDrawnEdge('comment-on')).toBe(false)
  })
})
