/**
 * Query wrappers for the `video_sources` cache table.
 *
 * Mirrors the pattern in ./notes.ts: each function takes an open DB, uses inline
 * prepared statements, and is side-effect-free beyond the DB call.
 *
 * @see src/main/db/migrations/0002_video_threads.sql
 * @see docs/specs/v0.2-youtube-annotation.md §Data model
 */
import type Database from 'better-sqlite3'
import type { VideoSource } from '../../../shared/types'

type DB = Database.Database

interface UpsertVideoSourceInput {
  video_id: string
  source_kind: 'youtube' | 'local'
  title?: string | null
  channel?: string | null
  thumbnail_url?: string | null
  duration_sec?: number | null
}

/**
 * Inserts or updates a video-metadata row. On conflict, each metadata field is
 * COALESCEd so a metadata-less re-registration never wipes an existing title.
 * `fetched_at` is refreshed to `Date.now()` on every upsert.
 */
export function upsertVideoSource(db: DB, input: UpsertVideoSourceInput): void {
  db.prepare(
    `INSERT INTO video_sources
       (video_id, source_kind, title, channel, thumbnail_url, duration_sec, fetched_at)
     VALUES
       (@video_id, @source_kind, @title, @channel, @thumbnail_url, @duration_sec, @fetched_at)
     ON CONFLICT(video_id) DO UPDATE SET
       source_kind   = excluded.source_kind,
       title         = COALESCE(excluded.title, video_sources.title),
       channel       = COALESCE(excluded.channel, video_sources.channel),
       thumbnail_url = COALESCE(excluded.thumbnail_url, video_sources.thumbnail_url),
       duration_sec  = COALESCE(excluded.duration_sec, video_sources.duration_sec),
       fetched_at    = excluded.fetched_at`,
  ).run({
    video_id: input.video_id,
    source_kind: input.source_kind,
    title: input.title ?? null,
    channel: input.channel ?? null,
    thumbnail_url: input.thumbnail_url ?? null,
    duration_sec: input.duration_sec ?? null,
    fetched_at: Date.now(),
  })
}

/**
 * Retrieves a video-metadata row, or null if not cached.
 *
 * @see docs/specs/v0.2-youtube-annotation.md §Data model
 */
export function getVideoSource(db: DB, videoId: string): VideoSource | null {
  return (
    (db
      .prepare(
        `SELECT video_id, source_kind, title, channel, thumbnail_url, duration_sec, fetched_at
         FROM video_sources WHERE video_id = ?`,
      )
      .get(videoId) as VideoSource | undefined) ?? null
  )
}

/**
 * Fills duration lazily (oEmbed omits it; the player supplies it on first load).
 *
 * Why: forced overwrite — distinct from `upsertVideoSource`'s COALESCE, which can
 * only fill a null duration, never correct a stale one. Unknown id → silent no-op.
 *
 * @see docs/specs/v0.2-youtube-annotation.md §Data model
 */
export function setVideoDuration(db: DB, videoId: string, durationSec: number): void {
  db.prepare(`UPDATE video_sources SET duration_sec = ? WHERE video_id = ?`).run(
    durationSec,
    videoId,
  )
}
