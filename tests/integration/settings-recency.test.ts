import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'
import { getSetting, setSetting } from '../../src/main/db/queries/settings'

let dir: string
let db: ReturnType<typeof openDb>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linsae-set-'))
  db = openDb(join(dir, 'test.db'))
  runMigrations(db)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('app_settings round-trip (real file db)', () => {
  it('defaults to null when absent, persists across reopen', () => {
    expect(getSetting(db, 'notes.recencyMode')).toBeNull()
    setSetting(db, 'notes.recencyMode', 'recent')
    db.close()
    db = openDb(join(dir, 'test.db'))
    expect(getSetting(db, 'notes.recencyMode')).toBe('recent')
  })
})
