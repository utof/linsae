// @vitest-environment node
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAppRequest } from './app-protocol'

const roots = { rendererDir: '/app/out/renderer', attachmentsDir: '/data/attachments' }

describe('resolveAppRequest', () => {
  it("maps '/' to the renderer index.html", () => {
    expect(resolveAppRequest('/', roots)).toBe(join('/app/out/renderer', 'index.html'))
  })

  it('maps a bundle asset path under the renderer dir', () => {
    expect(resolveAppRequest('/assets/index-abc.js', roots)).toBe(
      join('/app/out/renderer', 'assets/index-abc.js'),
    )
  })

  it('maps a /_media/ path under the attachments dir', () => {
    expect(resolveAppRequest('/_media/2026/05/deadbeef.png', roots)).toBe(
      join('/data/attachments', '2026/05/deadbeef.png'),
    )
  })

  it('rejects bundle path traversal (returns null)', () => {
    expect(resolveAppRequest('/../../secret.txt', roots)).toBeNull()
  })

  it('rejects media path traversal (returns null)', () => {
    expect(resolveAppRequest('/_media/../../secret.txt', roots)).toBeNull()
  })

  it('rejects a bare /_media/ directory request (no listing)', () => {
    expect(resolveAppRequest('/_media/', roots)).toBeNull()
  })
})
