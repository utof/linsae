import { describe, expect, it } from 'vitest'
import { normalizeSlug, slugFromBody } from './slug'

describe('normalizeSlug', () => {
  it('lowercases and trims', () => {
    expect(normalizeSlug('  Spectral Sequences  ')).toBe('spectral sequences')
  })
  it('collapses internal whitespace', () => {
    expect(normalizeSlug('foo   bar')).toBe('foo bar')
  })
  it('returns empty string for whitespace-only input', () => {
    expect(normalizeSlug('   ')).toBe('')
  })
})

describe('slugFromBody', () => {
  it('uses first markdown heading', () => {
    expect(slugFromBody('# Spectral Sequences\n\nfoo')).toBe('spectral sequences')
  })
  it('uses first non-empty line when no heading', () => {
    expect(slugFromBody('\n\nthe collapse on E_2 question\n\nmore')).toBe(
      'the collapse on e_2 question',
    )
  })
  it('strips heading hashes of any level', () => {
    expect(slugFromBody('### Lemma 3.2')).toBe('lemma 3.2')
  })
  it('returns empty string for empty body', () => {
    expect(slugFromBody('')).toBe('')
  })
  it('keeps raw markdown chars after the rewire to shared titleLine (parity)', () => {
    // Parity: the slug strips ONLY the heading marker, never emphasis markup,
    // so titleLine-delegation must stay byte-identical to the prior impl.
    expect(slugFromBody('# **Bold**')).toBe('**bold**')
    expect(slugFromBody('foo  bar')).toBe('foo bar')
    expect(slugFromBody('   ')).toBe('')
  })
})
