import { describe, expect, it } from 'vitest'
import { parseFrontmatter, serializeFrontmatter } from './frontmatter'

describe('parseFrontmatter', () => {
  it('parses a typical note', () => {
    const file = `---
id: 0190a1b2-c3d4-7e8f-9012-345678901234
slug: spectral sequences
type: claim
created_at: 1737000000000
updated_at: 1737000060000
---

body text here
more body`
    const r = parseFrontmatter(file)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.frontmatter.id).toBe('0190a1b2-c3d4-7e8f-9012-345678901234')
    expect(r.frontmatter.slug).toBe('spectral sequences')
    expect(r.frontmatter.type).toBe('claim')
    expect(r.body).toBe('body text here\nmore body')
  })
  it('returns ok=false on malformed YAML', () => {
    const file = `---
slug: [unclosed bracket
---
body`
    const r = parseFrontmatter(file)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/yaml|parse/i)
  })
  it('returns ok=false when no frontmatter delimiters', () => {
    expect(parseFrontmatter('just a body, no fences').ok).toBe(false)
  })
  it('parses aliases as an array if present', () => {
    const file = `---
id: x
slug: a
type: claim
created_at: 1
updated_at: 2
aliases:
  - the SS post
  - serre stuff
---
body`
    const r = parseFrontmatter(file)
    expect(r.ok && r.frontmatter.aliases).toEqual(['the SS post', 'serre stuff'])
  })
})

describe('serializeFrontmatter', () => {
  it('round-trips a parsed note', () => {
    const original = `---
id: 0190a1b2-c3d4-7e8f-9012-345678901234
slug: spectral sequences
type: claim
created_at: 1737000000000
updated_at: 1737000060000
---

body text here`
    const parsed = parseFrontmatter(original)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const round = serializeFrontmatter(parsed.frontmatter, parsed.body)
    const reparsed = parseFrontmatter(round)
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.frontmatter).toEqual(parsed.frontmatter)
    expect(reparsed.body).toBe(parsed.body)
  })
})
