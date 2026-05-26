import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from './atomic-write'
import {
  type NoteFrontmatter,
  type ParseResult,
  parseFrontmatter,
  serializeFrontmatter,
} from './frontmatter'

/**
 * Manages the on-disk note directory: creates, reads, lists, and stats `.md`
 * note files that use the `---\n<yaml>\n---\n\n<body>` format.
 *
 * Why: Centralises all file↔note I/O behind a single class so that the
 * reconciler, IPC handlers, and tests can interact with the notes directory
 * through a stable interface rather than scattering `readFileSync` /
 * `atomicWriteFile` calls across the codebase. Atomicity is delegated to
 * {@link atomicWriteFile}; frontmatter parsing/serialisation is delegated to
 * {@link parseFrontmatter} and {@link serializeFrontmatter}.
 *
 * @see docs/plans/v0.1-rolling-feed-and-search.md
 * @see src/main/files/atomic-write.ts
 * @see src/main/files/frontmatter.ts
 */
export class NotesDir {
  /**
   * @param dir - Absolute path to the notes directory. Created (recursively)
   *   if it does not already exist.
   *
   * Why: Allows callers (and tests) to pass a fresh `mkdtempSync` directory
   * without needing a separate creation step, while production code can point
   * at the user's configured notes folder regardless of whether it pre-exists.
   */
  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  /**
   * Returns the absolute path for the `.md` file that stores the note with
   * the given `id`.
   *
   * Why: Keeps the `<id>.md` filename convention in one place so that
   * `writeNote`, `readNote`, and `statNote` all agree on paths.
   */
  private pathFor(id: string): string {
    return join(this.dir, `${id}.md`)
  }

  /**
   * Serialises `fm` + `body` and writes the result to `<dir>/<fm.id>.md` via
   * {@link atomicWriteFile} (write-fsync-rename, crash-safe).
   *
   * @param fm   - Frontmatter whose `id` determines the filename.
   * @param body - Prose body (no leading/trailing newlines required).
   *
   * Why: A single write entry-point ensures every note file on disk has been
   * produced by `serializeFrontmatter`, preventing ad-hoc format divergence.
   *
   * @see docs/specs/v0.1-rolling-feed-and-search.md §Write atomicity
   */
  writeNote(fm: NoteFrontmatter, body: string): void {
    atomicWriteFile(this.pathFor(fm.id), serializeFrontmatter(fm, body))
  }

  /**
   * Reads `<dir>/<id>.md` and returns a {@link ParseResult} discriminated
   * union — `{ ok: true, frontmatter, body }` on success, `{ ok: false,
   * error }` when the file is absent or its frontmatter is malformed.
   *
   * @param id - UUIDv7 note identifier (used as the stem of the `.md` file).
   *
   * Why: Returns `ok: false` rather than throwing so that the reconciler can
   * skip malformed files without crashing the whole scan
   * (reconciler plan §malformed-skip).
   *
   * @see docs/plans/v0.1-rolling-feed-and-search.md §malformed-skip
   */
  readNote(id: string): ParseResult {
    const p = this.pathFor(id)
    if (!existsSync(p)) return { ok: false, error: 'file does not exist' }
    const raw = readFileSync(p, 'utf8')
    return parseFrontmatter(raw)
  }

  /**
   * Returns the stem (id) of every `.md` file in the notes directory, in
   * filesystem order (unsorted).
   *
   * Why: The reconciler needs to enumerate all on-disk notes to detect
   * externally created files and deletions without relying on the SQLite
   * index, which may be stale after an external edit session.
   *
   * @see docs/plans/v0.1-rolling-feed-and-search.md §Reconciler
   */
  listNoteIds(): string[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
  }

  /**
   * Returns `mtime` and `size` for `<dir>/<id>.md`, or `null` if the file
   * does not exist.
   *
   * Why: The reconciler uses `mtimeMs` to detect whether a file has changed
   * since the last DB sync without re-reading and parsing the full file
   * (cheap pre-filter before the costlier `readNote` + hash check).
   *
   * @param id - UUIDv7 note identifier.
   *
   * @see docs/plans/v0.1-rolling-feed-and-search.md §Reconciler §stat pre-filter
   */
  statNote(id: string): { mtimeMs: number; size: number } | null {
    const p = this.pathFor(id)
    if (!existsSync(p)) return null
    const s = statSync(p)
    return { mtimeMs: s.mtimeMs, size: s.size }
  }
}
