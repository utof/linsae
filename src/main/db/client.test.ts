// @vitest-environment node
/**
 * Integration tests for SQLite client + migration runner.
 * Uses a real on-disk SQLite file in a mkdtempSync tmpdir.
 * @see src/main/db/client.ts
 * @see src/main/db/migrate.ts
 * Why: native better-sqlite3 binding requires ABI alignment — run
 * `pnpm rebuild:node` before `pnpm test`. jsdom environment is NOT
 * used here; Vitest runs this in the node environment via
 * `@vitest-environment node` docblock.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from './client'
import { runMigrations } from './migrate'

describe('openDb', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'linsae-test-'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('opens an in-memory database', () => {
    db = openDb(':memory:')
    expect(db.open).toBe(true)
    const mode = db.pragma('journal_mode', { simple: true })
    // openDb skips the WAL pragma for ':memory:', so mode must report 'memory'.
    expect(mode).toBe('memory')
  })

  it('opens an on-disk database with WAL journal mode and foreign keys enabled', () => {
    const dbPath = join(tmpDir, 'test.db')
    db = openDb(dbPath)
    expect(db.open).toBe(true)
    const journalMode = db.pragma('journal_mode', { simple: true })
    expect(journalMode).toBe('wal')
    const foreignKeys = db.pragma('foreign_keys', { simple: true })
    expect(foreignKeys).toBe(1)
  })
})

describe('runMigrations', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'linsae-test-'))
    db = openDb(join(tmpDir, 'mig.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates all v0.1 tables on first run', () => {
    runMigrations(db)

    const tableNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string
      }[]
    ).map((r) => r.name)

    expect(tableNames).toContain('notes')
    expect(tableNames).toContain('note_aliases')
    expect(tableNames).toContain('links')
    expect(tableNames).toContain('note_revisions')
    expect(tableNames).toContain('topic_paths')
    expect(tableNames).toContain('note_actions')
    expect(tableNames).toContain('notes_fts')
    expect(tableNames).toContain('_migrations')
  })

  it('records the migration in _migrations', () => {
    runMigrations(db)

    const rows = db.prepare('SELECT name FROM _migrations ORDER BY name').all() as {
      name: string
    }[]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.name).toBe('0001_init.sql')
    expect(rows[1]!.name).toBe('0002_video_threads.sql')
  })

  it('is idempotent — running twice does not error or duplicate records', () => {
    runMigrations(db)
    runMigrations(db)

    const rows = db.prepare('SELECT name FROM _migrations').all() as { name: string }[]
    expect(rows).toHaveLength(2)
  })

  it('creates FTS5 virtual table notes_fts', () => {
    runMigrations(db)

    const vtab = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes_fts'")
      .get() as { name: string } | undefined
    expect(vtab?.name).toBe('notes_fts')
  })

  it('FTS5 triggers index newly inserted notes', () => {
    runMigrations(db)

    db.prepare(
      `INSERT INTO notes (id, slug, body, type, created_at, updated_at)
       VALUES ('id1', 'hello-world', 'hello world content', 'claim', 1000, 1000)`,
    ).run()

    const hits = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'hello'").all() as {
      rowid: number
    }[]
    expect(hits.length).toBeGreaterThan(0)
  })
})
