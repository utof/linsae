// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { watchUrl } from './watch-url'

describe('watchUrl', () => {
  it('bare id → canonical watch url', () => {
    expect(watchUrl('M7lc1UVf-VE')).toBe('https://www.youtube.com/watch?v=M7lc1UVf-VE')
  })
  it('passes a full watch url through (normalized to v=)', () => {
    expect(watchUrl('https://www.youtube.com/watch?v=abc12345678&t=5')).toBe(
      'https://www.youtube.com/watch?v=abc12345678',
    )
  })
  it('parses youtu.be short links', () => {
    expect(watchUrl('https://youtu.be/abc12345678')).toBe(
      'https://www.youtube.com/watch?v=abc12345678',
    )
  })
})
