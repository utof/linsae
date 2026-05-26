import { describe, expect, it } from 'vitest'
import { extractWikilinks } from './wikilinks'

describe('extractWikilinks', () => {
  it('returns empty array when body has no links', () => {
    expect(extractWikilinks('plain text only')).toEqual([])
  })
  it('extracts a single [[target]] with normalized slug', () => {
    expect(extractWikilinks('see [[Spectral Sequences]] here')).toEqual([
      {
        slug: 'spectral sequences',
        display: 'Spectral Sequences',
        section: null,
        raw: '[[Spectral Sequences]]',
      },
    ])
  })
  it('extracts [[target|display]] with display preserved verbatim', () => {
    expect(extractWikilinks('see [[Note A|the SS post]] here')).toEqual([
      { slug: 'note a', display: 'the SS post', section: null, raw: '[[Note A|the SS post]]' },
    ])
  })
  it('extracts [[target#section]] with section preserved verbatim', () => {
    expect(extractWikilinks('see [[Hatcher#5.3]]')).toEqual([
      { slug: 'hatcher', display: 'Hatcher', section: '5.3', raw: '[[Hatcher#5.3]]' },
    ])
  })
  it('extracts [[target#section|display]] (section then display)', () => {
    expect(extractWikilinks('see [[Note A#L2|that lemma]]')).toEqual([
      { slug: 'note a', display: 'that lemma', section: 'L2', raw: '[[Note A#L2|that lemma]]' },
    ])
  })
  it('extracts multiple links in one body', () => {
    const r = extractWikilinks('one [[a]] two [[b]] three')
    expect(r.length).toBe(2)
    expect(r[0]!.slug).toBe('a')
    expect(r[1]!.slug).toBe('b')
  })
  it('ignores empty [[]] brackets', () => {
    expect(extractWikilinks('[[]] is invalid')).toEqual([])
  })
})
