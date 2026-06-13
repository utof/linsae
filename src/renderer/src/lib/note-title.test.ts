/**
 * The ONE title source for placeholders, picker, shelf, banner, recents
 * (spec §3 title derivation). Notes have no title field.
 * @see docs/specs/v0.4-canvas-mvp.md §3
 */
import { describe, expect, it } from 'vitest'
import { noteTitle } from './note-title'

const base = { slug: 'fallback-slug' }

describe('noteTitle', () => {
  it('takes the first non-empty body line, markdown-stripped', () => {
    expect(noteTitle({ ...base, body: '\n\n# Heading **bold** `code`\nrest' })).toBe(
      'Heading bold code',
    )
    expect(noteTitle({ ...base, body: '- item one\n- two' })).toBe('item one')
    expect(noteTitle({ ...base, body: '> quoted *em* [[wiki-link]]' })).toBe('quoted em wiki-link')
  })
  it('clamps to 80 chars with an ellipsis', () => {
    const t = noteTitle({ ...base, body: 'x'.repeat(200) })
    expect(t.length).toBe(80)
    expect(t.endsWith('…')).toBe(true)
  })
  it('falls back to the slug for empty bodies', () => {
    expect(noteTitle({ ...base, body: '' })).toBe('fallback-slug')
    expect(noteTitle({ ...base, body: '   \n\n  ' })).toBe('fallback-slug')
  })
})
