import { describe, expect, it } from 'vitest'
import {
  AttachmentsListInputSchema,
  AttachToNoteInputSchema,
  CaptureInputSchema,
  FetchOEmbedInputSchema,
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
