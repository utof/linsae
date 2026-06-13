import { describe, expect, it } from 'vitest'
import { fuzzyMatch } from './fuzzy'

const C = (titles: string[]) => titles.map((t, i) => ({ id: String(i), title: t }))

describe('fuzzyMatch', () => {
  it('matches a case-insensitive subsequence (cu → claude)', () => {
    const r = fuzzyMatch('cu', C(['claude']))
    expect(r).toHaveLength(1)
    expect(r[0]!.matched).toEqual([0, 3]) // c…l…a…u → indices of c,u in "claude"
  })
  it('drops non-subsequence candidates', () => {
    expect(fuzzyMatch('zzz', C(['claude']))).toHaveLength(0)
  })
  it('empty query returns all candidates in input order, score 0, matched []', () => {
    const r = fuzzyMatch('', C(['b', 'a']))
    expect(r.map((x) => x.title)).toEqual(['b', 'a'])
  })
  it('ranks consecutive runs + word-boundary higher', () => {
    // "fb" should rank "Foo Bar" (word-boundary f,b) above "fabulous" (f,b mid-word)
    const r = fuzzyMatch('fb', C(['fabulous', 'Foo Bar']))
    expect(r[0]!.title).toBe('Foo Bar')
  })
  it('matched indices are correct for highlight', () => {
    const r = fuzzyMatch('fb', C(['Foo Bar']))
    expect(r[0]!.matched).toEqual([0, 4]) // F…(space)B
  })
})
