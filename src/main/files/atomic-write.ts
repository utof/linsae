import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'

/**
 * Writes `contents` to `targetPath` crash-safely via a write-fsync-rename
 * sequence on a sibling `.tmp` file.
 *
 * Why: A plain `writeFileSync` can leave a half-written file if the process
 * crashes mid-write (power loss, SIGKILL). The tmp-fsync-rename pattern
 * guarantees the target either retains its previous content or receives the
 * complete new content — partial states are impossible because `renameSync`
 * is atomic on POSIX (single inode swap). On failure the `.tmp` is unlinked
 * so no stale temp files accumulate in the notes directory.
 *
 * @param targetPath - Absolute path of the destination file. Its parent
 *   directory must exist; if not, this function throws and leaves no temp file.
 * @param contents   - UTF-8 string to write.
 * @throws If the parent directory does not exist or any I/O syscall fails.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Storage architecture §Write atomicity (per save)
 */
export function atomicWriteFile(targetPath: string, contents: string): void {
  const tmpPath = `${targetPath}.tmp`
  const buf = Buffer.from(contents, 'utf8')
  let fd: number | null = null
  try {
    fd = openSync(tmpPath, 'w', 0o644)
    writeSync(fd, buf, 0, buf.length, 0)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmpPath, targetPath)
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore close error during cleanup */
      }
    }
    try {
      unlinkSync(tmpPath)
    } catch {
      /* ignore unlink error — .tmp may not yet exist */
    }
    throw e
  }
}
