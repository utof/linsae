// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../client'
import { runMigrations } from '../migrate'
import { getVideoSource, setVideoDuration, upsertVideoSource } from './video-sources'

let db: ReturnType<typeof openDb>
beforeEach(() => {
  db = openDb(':memory:')
  runMigrations(db)
})

describe('video-sources queries', () => {
  it('upsert then get round-trips all fields', () => {
    upsertVideoSource(db, {
      video_id: 'dQw4w9WgXcQ',
      source_kind: 'youtube',
      title: 'Never Gonna Give You Up',
      channel: 'Rick Astley',
      thumbnail_url: 'https://i.ytimg.com/x.jpg',
      duration_sec: null,
    })
    const v = getVideoSource(db, 'dQw4w9WgXcQ')
    expect(v).toMatchObject({
      video_id: 'dQw4w9WgXcQ',
      source_kind: 'youtube',
      title: 'Never Gonna Give You Up',
      channel: 'Rick Astley',
      duration_sec: null,
    })
    expect(typeof v?.fetched_at).toBe('number')
  })

  it('get returns null for an unknown id', () => {
    expect(getVideoSource(db, 'nope')).toBeNull()
  })

  it('re-upsert does NOT clobber an existing non-null field with null (COALESCE)', () => {
    upsertVideoSource(db, { video_id: 'v1', source_kind: 'youtube', title: 'First' })
    upsertVideoSource(db, { video_id: 'v1', source_kind: 'youtube', title: null })
    expect(getVideoSource(db, 'v1')?.title).toBe('First')
  })

  it('setVideoDuration fills duration lazily', () => {
    upsertVideoSource(db, { video_id: 'v1', source_kind: 'youtube' })
    setVideoDuration(db, 'v1', 2237)
    expect(getVideoSource(db, 'v1')?.duration_sec).toBe(2237)
  })
})
