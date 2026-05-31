import { describe, expect, it } from 'vitest'
import { parseYouTubeUrl } from './parse-youtube-url'

describe('parseYouTubeUrl', () => {
  it('parses watch URLs', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(parseYouTubeUrl('watch this https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s ok')).toBe(
      'dQw4w9WgXcQ',
    )
  })
  it('parses youtu.be short URLs', () => {
    expect(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?si=abc')).toBe('dQw4w9WgXcQ')
  })
  it('parses embed/nocookie URLs', () => {
    expect(parseYouTubeUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    )
  })
  it('returns null for non-youtube text', () => {
    expect(parseYouTubeUrl('https://vimeo.com/123')).toBeNull()
    expect(parseYouTubeUrl('just a note')).toBeNull()
  })
})
