/**
 * Persist or clear a non-destructive SVG annotation overlay for a screenshot
 * attachment. Extracted as a single-input-object function mirroring the
 * `persistCapture(db, input)` pattern so it can be unit-tested independently
 * of the Electron IPC layer.
 *
 * Sidecar path contract: `<same yyyy/mm dir as base_path>/<attachmentId>.svg`
 * so the last-3-segment `mediaUrlFromPath` contract is preserved and the shell
 * can serve it without config changes.
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §IPC contract §Sidecar identity
 * @see src/main/media/persist-capture.ts (structural mirror)
 * @see src/main/media/atomic-write.ts (crash-safe write)
 */
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import { getAttachment, setOverlayPath, softDeleteAttachment } from '../db/queries/attachments'
import { atomicWriteFileSync } from './atomic-write'

type DB = Database.Database

export interface PersistOverlayInput {
  /** The attachment row id. */
  id: string
  /**
   * The serialized SVG string, or `null` to clear the overlay.
   * When `null`, the sidecar file is deleted (if present) and `overlay_path`
   * is set to `NULL`.
   */
  svg: string | null
}

export interface PersistOverlayResult {
  /** Absolute path to the written sidecar, or `null` when the overlay was cleared. */
  overlayPath: string | null
}

/**
 * Write or clear the SVG sidecar for an attachment.
 *
 * Guards:
 * - Throws if the row is missing (unknown id) — no file is written.
 * - Throws if the row has `deleted_at` set (soft-deleted) — no file is written.
 *
 * Why throw-before-write: the spec requires no orphaned `.svg` on disk for
 * unknown/deleted attachment ids.
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §IPC contract (saveOverlay handler)
 */
export function persistOverlay(db: DB, input: PersistOverlayInput): PersistOverlayResult {
  const row = getAttachment(db, input.id)

  if (row === null) {
    throw new Error(`persistOverlay: attachment not found (id=${input.id})`)
  }
  if (row.deleted_at !== null) {
    throw new Error(`persistOverlay: attachment is deleted (id=${input.id})`)
  }

  // Derive sidecar path: same yyyy/mm directory as the base PNG, keyed by
  // attachment id so deduped-PNG attachments get distinct sidecars (spec §Sidecar identity).
  const sidecarPath = join(dirname(row.base_path), `${input.id}.svg`)

  if (input.svg !== null) {
    // Atomic write — crash-safe; never leaves a partial file.
    atomicWriteFileSync(sidecarPath, Buffer.from(input.svg, 'utf8'))
    setOverlayPath(db, { id: input.id, overlayPath: sidecarPath })
    return { overlayPath: sidecarPath }
  }

  // svg === null → clear
  if (existsSync(sidecarPath)) {
    rmSync(sidecarPath)
  }
  setOverlayPath(db, { id: input.id, overlayPath: null })
  return { overlayPath: null }
}

/**
 * Remove an attachment: delete its SVG sidecar (if any), then soft-delete the
 * row. Extracted as a testable unit mirroring `persistOverlay` so the
 * `attachments:remove` handler stays a thin Zod-parse + delegate.
 *
 * Tolerant of unknown ids: `getAttachment` returns `null` (no sidecar to
 * delete) and `softDeleteAttachment` is a silent no-op — no throw. The base
 * PNG bytes on disk are NOT touched (reclamation is a future concern).
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §IPC contract (attachments.remove)
 * @see src/main/db/queries/attachments.ts (softDeleteAttachment)
 */
export function removeAttachment(db: DB, input: { id: string }): void {
  const row = getAttachment(db, input.id)
  if (row?.overlay_path && existsSync(row.overlay_path)) {
    rmSync(row.overlay_path)
  }
  softDeleteAttachment(db, input.id)
}
