/**
 * Idempotent SQL migration runner for the linsae v0.1 schema.
 *
 * Migration files live in `./migrations/*.sql` and are bundled via Vite's
 * `import.meta.glob` with `query: '?raw'` so they are inlined as strings
 * at build time — no `fs.readFile` calls at runtime.
 *
 * Idempotency: the `_migrations` table tracks applied names; each call skips
 * already-applied files. Running `runMigrations` twice is always safe.
 *
 * @see https://v7.vite.dev/guide/features#glob-import (query / import / eager options)
 * @see src/main/db/migrations/0001_init.sql
 * Why: Sequential numbered files give deterministic ordering; the `_migrations`
 * guard means adding a new file never re-applies an old one.
 */

import type Database from 'better-sqlite3'

type DB = Database.Database

/**
 * All migration SQL files bundled eagerly as raw strings.
 * Keys are relative paths like `./migrations/0001_init.sql`.
 * Values are the full SQL text.
 *
 * Vite 7 syntax verified: { query: '?raw', import: 'default', eager: true }
 * @see https://v7.vite.dev/guide/features#glob-import
 */
const migrations = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/**
 * Applies any pending SQL migrations to `db` in filename order.
 *
 * - Creates `_migrations` table if absent (allows the table to be absent
 *   before the first run — the migration SQL itself also creates it, so
 *   the runner ensures it exists before querying it).
 * - Skips already-applied migrations.
 * - Wraps each migration in a transaction for atomicity.
 *
 * @param db - An open better-sqlite3 Database instance.
 * @see src/main/db/client.ts openDb
 */
export function runMigrations(db: DB): void {
  // Bootstrap: _migrations may not exist yet (before any migration runs).
  // Check sqlite_master rather than pre-creating the table, because 0001_init.sql
  // itself creates _migrations — a pre-CREATE would cause "table already exists".
  // Why: the migration SQL is the single source of schema truth; the runner must
  // not duplicate DDL. See ADR to-be-written on migration runner bootstrap.
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_migrations' LIMIT 1")
    .get()

  const applied = new Set<string>(
    tableExists
      ? (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name)
      : [],
  )

  const entries = Object.entries(migrations)
    .map(([path, sql]) => [path.split('/').pop()!, sql] as const)
    .sort(([a], [b]) => a.localeCompare(b))

  for (const [name, sql] of entries) {
    if (applied.has(name)) continue
    const apply = db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now())
    })
    apply()
  }
}
