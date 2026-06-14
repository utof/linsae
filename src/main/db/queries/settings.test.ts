// @vitest-environment node
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { getSetting, setSetting } from './settings'

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
})

describe('settings query', () => {
  it('returns null for an absent key', () => {
    expect(getSetting(db, 'notes.recencyMode')).toBeNull()
  })
  it('round-trips a JSON-encoded value', () => {
    setSetting(db, 'notes.recencyMode', 'recent')
    expect(getSetting(db, 'notes.recencyMode')).toBe('recent')
  })
  it('upserts (set twice keeps one row, last wins)', () => {
    setSetting(db, 'k', 'a')
    setSetting(db, 'k', 'b')
    expect(getSetting(db, 'k')).toBe('b')
    expect((db.prepare('SELECT count(*) c FROM app_settings').get() as { c: number }).c).toBe(1)
  })
})
