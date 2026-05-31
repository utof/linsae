/**
 * Persist a captured frame: hash the PNG bytes, write them (deduped by hash —
 * skip if the file already exists), and insert an `attachments` row (born an
 * orphan, `note_id = NULL`, set later by `attachToNote` on post). Returns the
 * row id + path + metadata for the renderer's pending chip — never the Buffer
 * (spec §Capture: "return the path … never the raw Buffer").
 *
 * Dedup is at the file/`base_sha256` layer: two captures of identical bytes
 * share the PNG file but get distinct `attachments` rows (spec §Cardinality B4).
 *
 * @see docs/specs/v0.2-youtube-annotation.md §Capture subsystem
 * @see src/main/db/queries/attachments.ts (insertAttachment)
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { insertAttachment } from '../db/queries/attachments'
import { atomicWriteFileSync } from './atomic-write'
import { sha256Hex } from './sha256'

type DB = Database.Database

export interface PersistCaptureInput {
  png: Buffer
  attachmentsDir: string
  videoId: string
  t: number
  width: number
  height: number
  devicePixelRatio: number
}

export interface PersistCaptureResult {
  id: string
  path: string
  sha256: string
  width: number
  height: number
  devicePixelRatio: number
}

/** Writes the frame (deduped) and inserts an orphan attachment row. */
export function persistCapture(db: DB, input: PersistCaptureInput): PersistCaptureResult {
  const sha256 = sha256Hex(input.png)
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const path = join(input.attachmentsDir, yyyy, mm, `${sha256}.png`)

  // Dedup: identical bytes already on disk → skip the write, keep the file.
  if (!existsSync(path)) atomicWriteFileSync(path, input.png)

  const row = insertAttachment(db, {
    kind: 'screenshot',
    base_sha256: sha256,
    base_path: path,
    video_id: input.videoId,
    time_seconds: input.t,
    width_px: input.width,
    height_px: input.height,
    device_pixel_ratio: input.devicePixelRatio,
  })

  return {
    id: row.id,
    path,
    sha256,
    width: input.width,
    height: input.height,
    devicePixelRatio: input.devicePixelRatio,
  }
}
