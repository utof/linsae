/**
 * Content hash for screenshot dedup. The PNG bytes' sha256 is both the dedup
 * key and the on-disk filename (`<sha>.png`), so identical frames collapse to
 * one file (spec §Capture, ADR 0009).
 *
 * @see docs/specs/v0.2-youtube-annotation.md §Capture subsystem
 */
import { createHash } from 'node:crypto'

/** Returns the lowercase hex sha256 of `bytes`. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
