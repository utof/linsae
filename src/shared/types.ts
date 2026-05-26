// Minimal stubs — expanded in Task 6.
// Why: tests/setup.tsx needs Note + SearchHit for the window.api mock typings;
// the full schema (tags, frontmatter, etc.) is defined in Task 6.

/** Core note record as persisted in SQLite and returned over IPC. */
export type Note = {
  id: string
  body: string
  createdAt: string
  updatedAt: string
}

/** A single FTS5 search result with rank and snippet. */
export type SearchHit = {
  noteId: string
  snippet: string
  rank: number
}
