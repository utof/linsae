/**
 * Opens a better-sqlite3 database with v0.1 PRAGMA defaults.
 *
 * WAL journal mode is applied for on-disk databases only — SQLite
 * rejects WAL for in-memory connections (`:memory:` path).
 * Foreign-key enforcement is always enabled.
 *
 * @see https://www.sqlite.org/wal.html
 * @see https://www.sqlite.org/foreignkeys.html
 * Why: WAL allows concurrent reads during writes; critical for the
 * renderer querying while the reconciler writes.
 */

import Database from 'better-sqlite3'

type DB = Database.Database

/**
 * Opens (or creates) a SQLite database at the given path.
 *
 * @param path - Absolute filesystem path, or `':memory:'` for tests.
 * @returns An open better-sqlite3 Database instance.
 * @see https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
 */
export function openDb(path: string): DB {
  const db = new Database(path)
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL')
  }
  db.pragma('foreign_keys = ON')
  return db
}
