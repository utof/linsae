import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWriteFile } from './atomic-write'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linsae-atomic-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('atomicWriteFile', () => {
  it('creates the file with the given contents', () => {
    const p = join(dir, 'a.md')
    atomicWriteFile(p, 'hello')
    expect(readFileSync(p, 'utf8')).toBe('hello')
  })
  it('overwrites existing file atomically (no .tmp left behind)', () => {
    const p = join(dir, 'a.md')
    atomicWriteFile(p, 'old')
    atomicWriteFile(p, 'new')
    expect(readFileSync(p, 'utf8')).toBe('new')
    expect(existsSync(`${p}.tmp`)).toBe(false)
  })
  it('does not leave a temp file when target dir does not exist (throws first)', () => {
    const p = join(dir, 'nonexistent-subdir', 'a.md')
    expect(() => atomicWriteFile(p, 'x')).toThrow()
    expect(existsSync(`${p}.tmp`)).toBe(false)
  })
})
