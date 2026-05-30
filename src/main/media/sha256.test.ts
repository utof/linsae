// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './sha256'

describe('sha256Hex', () => {
  it('hashes bytes to a 64-char lowercase hex digest', () => {
    const d = sha256Hex(Buffer.from('hello'))
    expect(d).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect(d).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable for identical bytes (dedup key)', () => {
    expect(sha256Hex(Buffer.from('x'))).toBe(sha256Hex(Buffer.from('x')))
  })
})
