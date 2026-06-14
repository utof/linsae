// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { deriveTitle, titleLine } from './note-title'

describe('titleLine', () => {
  it('takes the first non-empty line, stripping the heading marker', () => {
    expect(titleLine('# Hello World\n\nbody')).toBe('Hello World')
    expect(titleLine('\n\n  plain first line  \nmore')).toBe('plain first line')
    expect(titleLine('### Triple')).toBe('Triple')
  })
  it('returns empty string for an all-blank body', () => {
    expect(titleLine('   \n\n  ')).toBe('')
  })
})

describe('deriveTitle (display title — #105 cases)', () => {
  it('strips inline emphasis/code but keeps case', () => {
    expect(deriveTitle('# **Bold** Title')).toBe('Bold Title')
    expect(deriveTitle('_Italic_ start')).toBe('Italic start')
    expect(deriveTitle('`code` first')).toBe('code first')
  })
  it('strips a task-checkbox prefix', () => {
    expect(deriveTitle('- [ ] do the thing')).toBe('do the thing')
    expect(deriveTitle('- [x] done thing')).toBe('done thing')
  })
  it('unwraps wikilinks and md links', () => {
    expect(deriveTitle('[[Target]] note')).toBe('Target note')
    expect(deriveTitle('[label](http://x) note')).toBe('label note')
  })
  it('clamps to 80 code-points with an ellipsis (no surrogate split)', () => {
    const long = `# ${'a'.repeat(100)}`
    expect([...deriveTitle(long)]).toHaveLength(80)
    expect(deriveTitle(long).endsWith('…')).toBe(true)
  })
  it('returns empty string when the line is only markup (slug fallback is the caller)', () => {
    expect(deriveTitle('**__**')).toBe('')
  })
})
