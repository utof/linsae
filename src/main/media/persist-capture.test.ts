// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db/client'
import { runMigrations } from '../db/migrate'
import { getAttachmentsByHash } from '../db/queries/attachments'
import { persistCapture } from './persist-capture'

let dir: string
let db: ReturnType<typeof openDb>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linsae-pc-'))
  db = openDb(':memory:')
  runMigrations(db)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const png = Buffer.from('PNGBYTES')
const meta = { videoId: 'dQw4w9WgXcQ', t: 83.5, width: 2560, height: 1440, devicePixelRatio: 2 }

describe('persistCapture', () => {
  it('writes the PNG and inserts a hydrated orphan attachment row', () => {
    const r = persistCapture(db, { png, attachmentsDir: dir, ...meta })
    expect(existsSync(r.path)).toBe(true)
    expect(r.path.endsWith(`${r.sha256}.png`)).toBe(true)
    expect(r.width).toBe(2560)
    expect(r.height).toBe(1440)
    expect(r.devicePixelRatio).toBe(2)
    const rows = getAttachmentsByHash(db, r.sha256)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: r.id,
      note_id: null,
      kind: 'screenshot',
      video_id: 'dQw4w9WgXcQ',
      time_seconds: 83.5,
      width_px: 2560,
      device_pixel_ratio: 2,
    })
  })

  it('dedups identical bytes: one file on disk, but a distinct row per capture (spec B4)', () => {
    const a = persistCapture(db, { png, attachmentsDir: dir, ...meta })
    const mtime1 = statSync(a.path).mtimeMs
    const b = persistCapture(db, { png, attachmentsDir: dir, ...meta })
    expect(b.path).toBe(a.path) // same hash → same file
    expect(statSync(b.path).mtimeMs).toBe(mtime1) // file not rewritten
    expect(a.id).not.toBe(b.id) // distinct rows
    expect(getAttachmentsByHash(db, a.sha256)).toHaveLength(2)
  })

  it('lays the file out under <yyyy>/<mm>/<sha>.png', () => {
    const r = persistCapture(db, { png, attachmentsDir: dir, ...meta })
    // dir/<yyyy>/<mm>/<sha>.png → 3 path segments below attachmentsDir
    const rel = r.path.slice(dir.length).replace(/^[/\\]/, '')
    expect(rel.split(/[/\\]/)).toHaveLength(3)
    expect(readdirSync(dir)).toHaveLength(1) // one year dir
  })
})
