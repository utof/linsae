import yaml from 'js-yaml'
import type { NoteType } from '../../shared/types'

/**
 * The structured YAML frontmatter block that opens every note file.
 *
 * Why: Keeps identity and routing metadata (id, slug, type, timestamps, aliases)
 * separate from body prose so that the reconciler can update metadata without
 * touching body content. Fields mirror the SQLite `notes` table defined in
 * docs/specs/v0.1-rolling-feed-and-search.md §Data model.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md
 */
export interface NoteFrontmatter {
  id: string
  slug: string
  type: NoteType
  created_at: number
  updated_at: number
  deleted_at?: number
  aliases?: string[]
}

/**
 * Discriminated union returned by {@link parseFrontmatter}.
 *
 * Why: Forces callers to check `ok` before accessing `frontmatter` and `body`,
 * eliminating the need for thrown exceptions at call sites and making
 * malformed-file-skip semantics explicit (reconciler plan §malformed-skip).
 *
 * @see docs/plans/v0.1-rolling-feed-and-search.md
 */
export type ParseResult =
  | { ok: true; frontmatter: NoteFrontmatter; body: string }
  | { ok: false; error: string }

const DELIM = '---'

/**
 * Parses a raw note file string into structured frontmatter and body.
 *
 * Why: The file format is `---\n<yaml>\n---\n\n<body>`. Separating parse from
 * disk I/O keeps the logic pure and easily unit-testable. Returns `ok: false`
 * rather than throwing so the reconciler can skip malformed files without
 * crashing the whole scan.
 *
 * @param file - Full text content of a `.md` note file.
 * @returns {@link ParseResult} — either `{ ok: true, frontmatter, body }` or
 *   `{ ok: false, error }`.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md
 */
export function parseFrontmatter(file: string): ParseResult {
  if (!file.startsWith(DELIM)) return { ok: false, error: 'no frontmatter delimiter at start' }
  const rest = file.slice(DELIM.length).split('\n').slice(1).join('\n')
  const end = rest.indexOf(`\n${DELIM}`)
  if (end === -1) return { ok: false, error: 'no closing frontmatter delimiter' }
  const yamlText = rest.slice(0, end)
  // Why: strip the newline ending the closing "---" line, plus an optional blank separator
  // line (the canonical format uses one blank line; some editors may omit it).
  const body = rest.slice(end + DELIM.length + 1).replace(/^\n{1,2}/, '')
  try {
    const fm = yaml.load(yamlText) as NoteFrontmatter
    if (!fm || typeof fm.id !== 'string' || typeof fm.slug !== 'string') {
      return { ok: false, error: 'frontmatter missing required fields (id, slug)' }
    }
    return { ok: true, frontmatter: fm, body }
  } catch (e) {
    return { ok: false, error: `yaml parse error: ${(e as Error).message}` }
  }
}

/**
 * Serializes a {@link NoteFrontmatter} and body back into a note file string.
 *
 * Why: Used by the write path (create + update) to produce a canonical on-disk
 * format that `parseFrontmatter` can round-trip. Fixes `lineWidth: 100` to
 * prevent YAML from hard-wrapping long slug values, which would break parsing.
 *
 * @param fm   - The frontmatter object to serialize.
 * @param body - The prose body (no leading/trailing newlines required).
 * @returns The complete file string: `---\n<yaml>\n---\n\n<body>`.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md
 */
export function serializeFrontmatter(fm: NoteFrontmatter, body: string): string {
  const yamlText = yaml.dump(fm, { lineWidth: 100, noRefs: true }).trimEnd()
  return `---\n${yamlText}\n---\n\n${body}`
}
