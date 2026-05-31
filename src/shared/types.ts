// Shared types: mirror of the SQLite schema in
// docs/specs/v0.1-rolling-feed-and-search.md §Data model.
// Why: imported by both main and renderer over IPC; Task 6 Step 2 adds the matching Zod schemas.

export type NoteType = 'claim' | 'question' | 'source'

/**
 * What external thing a note is anchored to (JSON in notes.source_locator).
 * Media-agnostic (spec §Forward direction); v0.2.0 = youtube only. `t` (sec)
 * is omitted for anchorless comment-notes.
 */
export interface SourceLocator {
  media: 'youtube'
  video_id: string
  t?: number
}

export interface Note {
  id: string
  slug: string
  body: string
  type: NoteType
  created_at: number
  updated_at: number
  deleted_at: number | null
  source_kind?: string | null
  source_locator?: SourceLocator | null
}

export interface SearchHit {
  note: Note
  snippet: string
  rank: number
}

export interface ReconcileReport {
  scanned: number
  inserted: number
  updated: number
  deleted: number
  skipped: number
}

/** A cached video-metadata row (mirrors video_sources in 0002_video_threads.sql). */
export interface VideoSource {
  video_id: string
  source_kind: 'youtube' | 'local'
  title: string | null
  channel: string | null
  thumbnail_url: string | null
  duration_sec: number | null
  fetched_at: number
}

export type AttachmentKind = 'screenshot' | 'clip'

/** An attachment row (mirrors attachments in 0002_video_threads.sql). */
export interface Attachment {
  id: string
  note_id: string | null
  kind: AttachmentKind
  base_sha256: string
  base_path: string
  overlay_path: string | null
  video_id: string | null
  time_seconds: number | null
  width_px: number
  height_px: number
  device_pixel_ratio: number
  created_at: number
  deleted_at: number | null
}
