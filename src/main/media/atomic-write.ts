/**
 * Crash-safe file write: write to a sibling `.tmp`, fsync, then rename over the
 * target (rename is atomic on a single filesystem). Same invariant the note
 * write path uses (spec §Write atomicity); a torn write never leaves a partial
 * PNG that would later hash-mismatch.
 *
 * @see docs/specs/v0.2-youtube-annotation.md §Capture subsystem
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** Atomically writes `bytes` to `filePath`, creating parent dirs as needed. */
export function atomicWriteFileSync(filePath: string, bytes: Buffer): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, filePath)
}
