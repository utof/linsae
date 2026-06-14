/**
 * Generic app_settings key/value store (spec §1.3 / §8). Values are
 * JSON-encoded TEXT so any JSON-serialisable setting fits one schema. The
 * absence-default (e.g. recencyMode → 'frecent') is the caller's concern —
 * this layer returns null for an absent key. First consumer: notes.recencyMode.
 * #129 reuses this verbatim for its propagate toggle.
 * @see docs/specs/v0.5-command-search.md §8
 */
import type Database from 'better-sqlite3'

type DB = Database.Database

/** The decoded value for `key`, or null if unset. Throws never — a corrupt
 *  JSON value would be a bug we want to surface, not swallow. */
export function getSetting(db: DB, key: string): unknown {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? JSON.parse(row.value) : null
}

/** Upsert `key`→`value` (value JSON-encoded). */
export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value))
}
