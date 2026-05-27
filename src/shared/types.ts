// Shared types: mirror of the SQLite schema in
// docs/specs/v0.1-rolling-feed-and-search.md §Data model.
// Why: imported by both main and renderer over IPC; Task 6 Step 2 adds the matching Zod schemas.

export type NoteType = 'claim' | 'question' | 'source'

export interface Note {
  id: string
  slug: string
  body: string
  type: NoteType
  created_at: number
  updated_at: number
  deleted_at: number | null
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
