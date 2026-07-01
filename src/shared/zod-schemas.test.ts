import { describe, expect, it } from 'vitest'
import {
  AttachmentRemoveInputSchema,
  AttachmentsListInputSchema,
  AttachToNoteInputSchema,
  CaptureInputSchema,
  FetchOEmbedInputSchema,
  NotesCreateInputSchema,
  NotesListInputSchema,
  NotesUpdateInputSchema,
  SaveOverlayInputSchema,
  SourceLocatorSchema,
  VideoSourcesGetInputSchema,
  VideoSourcesUpsertInputSchema,
} from './zod-schemas'

describe('CaptureInputSchema', () => {
  it('accepts a well-formed capture request', () => {
    const v = CaptureInputSchema.parse({
      rect: { x: 0, y: 0, width: 640, height: 360 },
      videoId: 'dQw4w9WgXcQ',
      t: 83.5,
    })
    expect(v.videoId).toBe('dQw4w9WgXcQ')
  })
  it('rejects a missing rect field', () => {
    expect(() => CaptureInputSchema.parse({ videoId: 'x', t: 1 })).toThrow()
  })
  it('rejects a zero/negative-dimension rect (the invisible-iframe guard)', () => {
    const base = { videoId: 'x', t: 1 }
    expect(() =>
      CaptureInputSchema.parse({ ...base, rect: { x: 0, y: 0, width: 0, height: 360 } }),
    ).toThrow()
    expect(() =>
      CaptureInputSchema.parse({ ...base, rect: { x: 0, y: 0, width: 640, height: -1 } }),
    ).toThrow()
  })
  it('rejects an empty-string videoId', () => {
    expect(() =>
      CaptureInputSchema.parse({ rect: { x: 0, y: 0, width: 1, height: 1 }, videoId: '', t: 0 }),
    ).toThrow()
  })
})

describe('VideoSourcesUpsertInputSchema', () => {
  it("accepts sourceKind 'youtube'", () => {
    expect(
      VideoSourcesUpsertInputSchema.parse({ videoId: 'x', sourceKind: 'youtube' }).sourceKind,
    ).toBe('youtube')
  })
  it("rejects sourceKind 'local' at v0.2.0 (only youtube ships)", () => {
    expect(() =>
      VideoSourcesUpsertInputSchema.parse({ videoId: 'x', sourceKind: 'local' }),
    ).toThrow()
  })
  it('accepts optional oEmbed metadata fields', () => {
    const v = VideoSourcesUpsertInputSchema.parse({
      videoId: 'x',
      sourceKind: 'youtube',
      title: 'T',
      channel: 'C',
      thumbnailUrl: 'https://i.ytimg.com/x.jpg',
      durationSec: 100,
    })
    expect(v.title).toBe('T')
    expect(v.durationSec).toBe(100)
  })
  it('rejects a fractional or negative durationSec', () => {
    expect(() =>
      VideoSourcesUpsertInputSchema.parse({
        videoId: 'x',
        sourceKind: 'youtube',
        durationSec: 1.5,
      }),
    ).toThrow()
    expect(() =>
      VideoSourcesUpsertInputSchema.parse({ videoId: 'x', sourceKind: 'youtube', durationSec: -1 }),
    ).toThrow()
  })
})

describe('AttachmentsListInputSchema', () => {
  it('accepts an all-optional filter (empty object)', () => {
    expect(AttachmentsListInputSchema.parse({})).toEqual({})
  })
  it('accepts a single-filter object', () => {
    expect(AttachmentsListInputSchema.parse({ orphans: true }).orphans).toBe(true)
  })
})

describe('the remaining input schemas', () => {
  it('validate their minimal shapes', () => {
    expect(FetchOEmbedInputSchema.parse({ videoId: 'x' }).videoId).toBe('x')
    expect(AttachToNoteInputSchema.parse({ attachmentId: 'a', noteId: 'n' }).noteId).toBe('n')
    expect(VideoSourcesGetInputSchema.parse({ videoId: 'x' }).videoId).toBe('x')
  })
})

describe('NotesCreateInputSchema — empty-body rule', () => {
  it('allows empty body when source_kind is set (video-anchored note)', () => {
    const result = NotesCreateInputSchema.parse({
      body: '',
      source_kind: 'youtube',
      source_locator: { media: 'youtube', video_id: 'v' },
    })
    expect(result.body).toBe('')
  })

  it('rejects empty body when source_kind is absent', () => {
    expect(() => NotesCreateInputSchema.parse({ body: '' })).toThrow()
  })

  it('rejects whitespace-only body when source_kind is absent', () => {
    expect(() => NotesCreateInputSchema.parse({ body: '   ' })).toThrow()
  })

  it('accepts a non-empty body without source_kind', () => {
    const result = NotesCreateInputSchema.parse({ body: 'hello' })
    expect(result.body).toBe('hello')
  })

  it('allows a whitespace-only body when source_kind is set (gate is anchoring, not content)', () => {
    const result = NotesCreateInputSchema.parse({
      body: '   ',
      source_kind: 'youtube',
      source_locator: { media: 'youtube', video_id: 'v' },
    })
    expect(result.body).toBe('   ')
  })
})

describe('SaveOverlayInputSchema', () => {
  it('accepts a valid svg string + attachmentId', () => {
    const v = SaveOverlayInputSchema.parse({
      attachmentId: 'att-1',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    })
    expect(v.attachmentId).toBe('att-1')
    expect(v.svg).toContain('<svg')
  })

  it('accepts svg: null (clear overlay)', () => {
    const v = SaveOverlayInputSchema.parse({ attachmentId: 'att-1', svg: null })
    expect(v.svg).toBeNull()
  })

  it('rejects a non-svg string (does not start with <svg)', () => {
    expect(() => SaveOverlayInputSchema.parse({ attachmentId: 'att-1', svg: 'not svg' })).toThrow()
    expect(() =>
      SaveOverlayInputSchema.parse({ attachmentId: 'att-1', svg: '<div>nope</div>' }),
    ).toThrow()
  })

  it('rejects an over-cap string (> 512_000 chars)', () => {
    const huge = `<svg${'x'.repeat(512_000)}`
    expect(() => SaveOverlayInputSchema.parse({ attachmentId: 'att-1', svg: huge })).toThrow()
  })

  it('rejects missing attachmentId', () => {
    expect(() => SaveOverlayInputSchema.parse({ svg: '<svg></svg>' })).toThrow()
  })
})

describe('AttachmentRemoveInputSchema', () => {
  it('accepts a valid id', () => {
    const v = AttachmentRemoveInputSchema.parse({ id: 'att-123' })
    expect(v.id).toBe('att-123')
  })

  it('rejects a missing id', () => {
    expect(() => AttachmentRemoveInputSchema.parse({})).toThrow()
  })
})

describe('NotesUpdateInputSchema — empty-body rule', () => {
  it('allows empty body when source_kind is set (video-anchored note)', () => {
    const result = NotesUpdateInputSchema.parse({
      id: 'n1',
      body: '',
      type: 'source',
      source_kind: 'youtube',
    })
    expect(result.body).toBe('')
  })

  it('rejects empty body when source_kind is absent', () => {
    expect(() => NotesUpdateInputSchema.parse({ id: 'n1', body: '', type: 'claim' })).toThrow()
  })

  it('rejects whitespace-only body when source_kind is absent', () => {
    expect(() => NotesUpdateInputSchema.parse({ id: 'n1', body: '   ', type: 'claim' })).toThrow()
  })

  it('accepts a non-empty body without source_kind', () => {
    const result = NotesUpdateInputSchema.parse({ id: 'n1', body: 'x', type: 'claim' })
    expect(result.body).toBe('x')
  })
})

describe('NotesListInputSchema — excludeThreadChildren scope (#165)', () => {
  it('defaults excludeThreadChildren to undefined (absent) so the IPC handler is unfiltered by default (canvas pickers stay unfiltered)', () => {
    // The IPC handler uses `...(i.excludeThreadChildren ? { excludeThreadChildren: true } : {})`,
    // so `undefined` → the flag is never passed to listNotes → no child filtering.
    // This locks the "pickers unfiltered" invariant: as long as the schema produces
    // `undefined` when the field is absent, adding excludeThreadChildren: false to a
    // picker call would have identical effect to omitting it entirely.
    const parsed = NotesListInputSchema.parse({})
    expect(parsed.excludeThreadChildren).toBeUndefined()
    expect(parsed.limit).toBe(500) // default limit unchanged
  })

  it('passes excludeThreadChildren: true through when set (feed query path)', () => {
    const parsed = NotesListInputSchema.parse({ excludeThreadChildren: true })
    expect(parsed.excludeThreadChildren).toBe(true)
  })

  it('passes excludeThreadChildren: false through when explicitly set', () => {
    const parsed = NotesListInputSchema.parse({ excludeThreadChildren: false })
    expect(parsed.excludeThreadChildren).toBe(false)
  })
})

describe('SourceLocatorSchema — PdfLocator widening (B3)', () => {
  it('accepts a document-level pdf locator (no page/rect/quote)', () => {
    expect(SourceLocatorSchema.parse({ media: 'pdf', pdf_id: 'p1' })).toMatchObject({
      media: 'pdf',
      pdf_id: 'p1',
    })
  })
  it('still accepts a full excerpt locator and routes pdf vs youtube', () => {
    expect(
      SourceLocatorSchema.parse({
        media: 'pdf',
        pdf_id: 'p1',
        page: 42,
        rect: [0, 0, 1, 1],
        quote: 'q',
        prefix: '',
        suffix: '',
      }).media,
    ).toBe('pdf')
    expect(SourceLocatorSchema.parse({ media: 'youtube', video_id: 'abc' }).media).toBe('youtube')
  })
  it('accepts a partial locator (page present, other excerpt fields absent)', () => {
    // The intermediate state the widening newly admits; the PdfFeedNote
    // `page == null` discriminator (B3.4) hinges on page being distinguishable.
    const parsed = SourceLocatorSchema.parse({ media: 'pdf', pdf_id: 'p1', page: 42 })
    expect(parsed).toMatchObject({ media: 'pdf', pdf_id: 'p1', page: 42 })
    expect((parsed as { quote?: string }).quote).toBeUndefined()
  })
})
