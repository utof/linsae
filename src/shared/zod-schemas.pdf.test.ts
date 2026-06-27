// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { PdfLocator, YoutubeLocator } from './types'
import { NotesCreateInputSchema, SourceLocatorSchema } from './zod-schemas'

describe('PDF source_locator widening', () => {
  it('parses a youtube locator (backward compat)', () => {
    // Typed fixture: the YoutubeLocator interface must still satisfy the schema.
    const loc: YoutubeLocator = { media: 'youtube', video_id: 'abc', t: 12.5 }
    const r = SourceLocatorSchema.safeParse(loc)
    expect(r.success).toBe(true)
  })
  it('parses a pdf locator', () => {
    // Typed fixture: the PdfLocator interface must satisfy the schema (TS ⇆ Zod parity).
    const loc: PdfLocator = {
      media: 'pdf',
      pdf_id: '01HTEST',
      page: 42,
      rect: [1, 2, 3, 4],
      quote: 'the text',
      prefix: 'a',
      suffix: 'b',
      textStart: 10,
      textEnd: 18,
    }
    const r = SourceLocatorSchema.safeParse(loc)
    expect(r.success).toBe(true)
  })
  it('rejects an unknown media discriminant', () => {
    const r = SourceLocatorSchema.safeParse({ media: 'docx', path: '/x' })
    expect(r.success).toBe(false)
  })
  it('NotesCreateInputSchema accepts source_kind: pdf', () => {
    const r = NotesCreateInputSchema.safeParse({
      body: 'excerpt text',
      type: 'source',
      source_kind: 'pdf',
      source_locator: {
        media: 'pdf',
        pdf_id: '01H',
        page: 1,
        rect: [0, 0, 10, 10],
        quote: 'excerpt',
        prefix: '',
        suffix: '',
      },
    })
    expect(r.success).toBe(true)
  })
})
