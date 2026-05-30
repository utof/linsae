// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { oembedUrl, parseOEmbed } from './oembed'

describe('oembedUrl', () => {
  it('builds the youtube oEmbed endpoint for a video id', () => {
    expect(oembedUrl('dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json',
    )
  })
})

describe('parseOEmbed', () => {
  it('extracts the four fields the spec relies on', () => {
    const json = {
      title: 'Never Gonna Give You Up',
      author_name: 'Rick Astley',
      author_url: 'https://www.youtube.com/@RickAstleyYT',
      thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      type: 'video',
      html: '<iframe…>',
    }
    expect(parseOEmbed(json)).toEqual({
      title: 'Never Gonna Give You Up',
      author_name: 'Rick Astley',
      author_url: 'https://www.youtube.com/@RickAstleyYT',
      thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    })
  })

  it('returns null for a non-object / error body (fail-soft)', () => {
    expect(parseOEmbed(null)).toBeNull()
    expect(parseOEmbed('Not Found')).toBeNull()
    expect(parseOEmbed({ error: 'unauthorized' })).toBeNull()
  })

  it('falls back to empty strings when author/thumbnail fields are absent', () => {
    expect(parseOEmbed({ title: 'Only a title' })).toEqual({
      title: 'Only a title',
      author_name: '',
      author_url: '',
      thumbnail_url: '',
    })
  })
})
