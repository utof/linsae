// @vitest-environment node
/**
 * Integration test: saveOverlay / attachments.remove persistence.
 *
 * Uses real disk (mkdtempSync) + real SQLite (:memory: is fine here since we
 * don't need cross-session persistence — only file↔DB round-trip matters).
 *
 * @see src/main/media/persist-overlay.ts (persistOverlay, removeAttachment)
 * @see src/main/db/queries/attachments.ts (setOverlayPath, getAttachment)
 * @see docs/specs/v0.2.5-screenshot-annotation.md §IPC contract §Testing
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'
import {
  getAttachment,
  insertAttachment,
  softDeleteAttachment,
} from '../../src/main/db/queries/attachments'
import { atomicWriteFileSync } from '../../src/main/media/atomic-write'
import { persistOverlay, removeAttachment } from '../../src/main/media/persist-overlay'

let dir: string
let db: ReturnType<typeof openDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linsae-ov-'))
  db = openDb(':memory:')
  runMigrations(db)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Creates a real PNG file on disk and returns its path. */
function writePng(subDir: string, filename: string): string {
  const pngPath = join(dir, subDir, filename)
  atomicWriteFileSync(pngPath, Buffer.from('PNGBYTES'))
  return pngPath
}

const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>'

const baseMeta = {
  kind: 'screenshot' as const,
  base_sha256: 'abc123',
  video_id: 'dQw4w9WgXcQ',
  time_seconds: 83.5,
  width_px: 2560,
  height_px: 1440,
  device_pixel_ratio: 2,
}

describe('persistOverlay', () => {
  it('writes the SVG sidecar atomically and sets overlay_path (round-trip)', () => {
    const basePath = writePng('2024/06', 'abc123.png')
    const att = insertAttachment(db, { ...baseMeta, base_path: basePath })

    const result = persistOverlay(db, { id: att.id, svg: svgContent })
    expect(result.overlayPath).not.toBeNull()
    expect(result.overlayPath).toMatch(/\.svg$/)
    expect(result.overlayPath).toContain(att.id)
    expect(existsSync(result.overlayPath!)).toBe(true)

    const svgOnDisk = readFileSync(result.overlayPath!, 'utf8')
    expect(svgOnDisk).toBe(svgContent)

    const updated = getAttachment(db, att.id)
    expect(updated?.overlay_path).toBe(result.overlayPath)
  })

  it('svg:null deletes the sidecar file and nulls overlay_path', () => {
    const basePath = writePng('2024/06', 'abc123.png')
    const att = insertAttachment(db, { ...baseMeta, base_path: basePath })

    // First, save a non-null overlay
    const { overlayPath } = persistOverlay(db, { id: att.id, svg: svgContent })
    expect(existsSync(overlayPath!)).toBe(true)

    // Now clear it
    const result2 = persistOverlay(db, { id: att.id, svg: null })
    expect(result2.overlayPath).toBeNull()
    expect(existsSync(overlayPath!)).toBe(false)

    const updated = getAttachment(db, att.id)
    expect(updated?.overlay_path).toBeNull()
  })

  it('svg:null on an attachment with no sidecar does not throw', () => {
    const basePath = writePng('2024/06', 'abc123.png')
    const att = insertAttachment(db, { ...baseMeta, base_path: basePath })

    // overlay_path is null at this point; clearing should be a no-op
    const result = persistOverlay(db, { id: att.id, svg: null })
    expect(result.overlayPath).toBeNull()
  })

  it('dedup-keying: two attachments sharing one base_sha256/base_path get distinct <id>.svg sidecars', () => {
    const basePath = writePng('2024/06', 'abc123.png')
    // Both rows share the same base_path (content-dedup scenario)
    const att1 = insertAttachment(db, { ...baseMeta, base_path: basePath })
    const att2 = insertAttachment(db, { ...baseMeta, base_path: basePath })
    expect(att1.id).not.toBe(att2.id)

    const r1 = persistOverlay(db, {
      id: att1.id,
      svg: '<svg xmlns="http://www.w3.org/2000/svg">one</svg>',
    })
    const r2 = persistOverlay(db, {
      id: att2.id,
      svg: '<svg xmlns="http://www.w3.org/2000/svg">two</svg>',
    })

    // Distinct sidecar paths
    expect(r1.overlayPath).not.toBe(r2.overlayPath)
    expect(r1.overlayPath).toContain(att1.id)
    expect(r2.overlayPath).toContain(att2.id)

    // Content of each sidecar is correct and independent
    expect(readFileSync(r1.overlayPath!, 'utf8')).toContain('one')
    expect(readFileSync(r2.overlayPath!, 'utf8')).toContain('two')
  })

  it('non-destructive invariant: base PNG bytes are byte-identical before/after save', () => {
    const basePath = writePng('2024/06', 'abc123.png')
    const before = readFileSync(basePath)
    const att = insertAttachment(db, { ...baseMeta, base_path: basePath })

    persistOverlay(db, { id: att.id, svg: svgContent })

    const after = readFileSync(basePath)
    expect(Buffer.compare(before, after)).toBe(0)
  })

  it('unknown id → throws before any file write (no orphaned .svg created)', () => {
    const fakeId = 'does-not-exist'
    expect(() => persistOverlay(db, { id: fakeId, svg: svgContent })).toThrow(/not found|unknown/i)

    // No .svg files should have been created anywhere under dir
    const svgFiles = findSvgFiles(dir)
    expect(svgFiles).toHaveLength(0)
  })

  it('soft-deleted id → throws before any file write', () => {
    const basePath = writePng('2024/06', 'abc123.png')
    const att = insertAttachment(db, { ...baseMeta, base_path: basePath })
    softDeleteAttachment(db, att.id)

    expect(() => persistOverlay(db, { id: att.id, svg: svgContent })).toThrow(/deleted|not found/i)

    const svgFiles = findSvgFiles(dir)
    expect(svgFiles).toHaveLength(0)
  })
})

describe('removeAttachment', () => {
  it('with a sidecar present → deletes the .svg file AND soft-deletes the row', () => {
    const basePath = writePng('2024/06', 'abc123.png')
    const att = insertAttachment(db, { ...baseMeta, base_path: basePath })

    // Give it an overlay sidecar first.
    const { overlayPath } = persistOverlay(db, { id: att.id, svg: svgContent })
    expect(overlayPath).not.toBeNull()
    expect(existsSync(overlayPath!)).toBe(true)

    removeAttachment(db, { id: att.id })

    // Sidecar is gone.
    expect(existsSync(overlayPath!)).toBe(false)
    // Row is soft-deleted (deleted_at set).
    const row = getAttachment(db, att.id)
    expect(typeof row?.deleted_at).toBe('number')
    // Base PNG bytes survive on disk (deletes don't cascade to files).
    expect(existsSync(basePath)).toBe(true)
  })

  it('with NO sidecar (overlay_path null) → no throw, deleted_at still set', () => {
    const basePath = writePng('2024/06', 'abc123.png')
    const att = insertAttachment(db, { ...baseMeta, base_path: basePath })
    // overlay_path is null at this point.

    expect(() => removeAttachment(db, { id: att.id })).not.toThrow()

    const row = getAttachment(db, att.id)
    expect(typeof row?.deleted_at).toBe('number')
    // No .svg was ever created.
    expect(findSvgFiles(dir)).toHaveLength(0)
  })
})

/** Recursively finds all .svg files under a directory. */
function findSvgFiles(root: string): string[] {
  const results: string[] = []
  function walk(d: string): void {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry.endsWith('.svg')) results.push(full)
    }
  }
  try {
    walk(root)
  } catch {
    /* dir may not exist */
  }
  return results
}
