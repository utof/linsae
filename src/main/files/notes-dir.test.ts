import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotesDir } from './notes-dir'

let dir: string
let nd: NotesDir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linsae-notesdir-'))
  nd = new NotesDir(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('NotesDir', () => {
  it('writes a note file with frontmatter + body', () => {
    nd.writeNote(
      {
        id: '0190a1b2-c3d4-7e8f-9012-345678901234',
        slug: 'foo',
        type: 'claim',
        created_at: 1,
        updated_at: 1,
      },
      'body content',
    )
    const p = join(dir, '0190a1b2-c3d4-7e8f-9012-345678901234.md')
    const raw = readFileSync(p, 'utf8')
    expect(raw).toContain('slug: foo')
    expect(raw).toMatch(/\n\nbody content$/)
  })
  it('lists note ids by reading filenames', () => {
    nd.writeNote(
      {
        id: 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa',
        slug: 'a',
        type: 'claim',
        created_at: 1,
        updated_at: 1,
      },
      'a',
    )
    nd.writeNote(
      {
        id: 'bbbbbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb',
        slug: 'b',
        type: 'claim',
        created_at: 1,
        updated_at: 1,
      },
      'b',
    )
    const ids = nd.listNoteIds()
    expect(ids.sort()).toEqual([
      'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb',
    ])
  })
  it('reads a note back, returning frontmatter + body', () => {
    nd.writeNote(
      {
        id: 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa',
        slug: 'a',
        type: 'claim',
        created_at: 1,
        updated_at: 1,
      },
      'hello',
    )
    const r = nd.readNote('aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.frontmatter.slug).toBe('a')
    expect(r.body).toBe('hello')
  })
  it('returns ok=false when the file has bad frontmatter (does not throw)', () => {
    const p = join(dir, '0190a1b2-c3d4-7e8f-9012-345678901234.md')
    writeFileSync(p, '---\nslug: [unclosed\n---\nbody')
    const r = nd.readNote('0190a1b2-c3d4-7e8f-9012-345678901234')
    expect(r.ok).toBe(false)
  })
})
