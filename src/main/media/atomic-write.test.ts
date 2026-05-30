// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWriteFileSync } from './atomic-write'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linsae-aw-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('atomicWriteFileSync', () => {
  it('writes the file with the exact bytes', () => {
    const p = join(dir, 'a', 'b', 'c.png')
    atomicWriteFileSync(p, Buffer.from('PNGDATA'))
    expect(readFileSync(p).toString()).toBe('PNGDATA')
  })

  it('creates missing parent directories', () => {
    const p = join(dir, 'deep', 'nested', 'x.png')
    atomicWriteFileSync(p, Buffer.from('z'))
    expect(existsSync(p)).toBe(true)
  })

  it('leaves no .tmp turds behind', () => {
    const p = join(dir, 'x.png')
    atomicWriteFileSync(p, Buffer.from('z'))
    expect(readdirSync(dir).some((f) => f.includes('.tmp'))).toBe(false)
  })
})
