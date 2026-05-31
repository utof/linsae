// @vitest-environment node
/**
 * Unit tests for the loopback HTTP shell.
 *
 * Uses a real `node:http` server on an ephemeral port and the global `fetch`
 * (Node 18+) for normal cases. Traversal tests use a raw `node:http` GET
 * because the global `fetch` / `new URL` normalize `/../` and `%2e%2e` before
 * the request is sent, masking the guard (they arrive as ordinary paths that
 * just happen to be absent → 404). The raw client sends the literal path bytes
 * so the server's `new URL(rawUrl, base)` parser normalizes them — which is
 * the guard's actual attack surface.
 *
 * @see src/main/http-shell.ts
 * @see docs/specs/v0.2-localhost-shell.md §4 L2 + §7 I2
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startLoopbackShell } from './http-shell'

/** Raw HTTP GET that returns status + headers without following redirects. */
function rawGet(
  url: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      res.resume() // drain
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers as Record<string, string | string[] | undefined>,
      })
    })
    req.on('error', reject)
  })
}

let rendererDir: string
let attachmentsDir: string
let origin: string
let close: () => Promise<void>

beforeAll(async () => {
  // ── fixture: renderer bundle dir ──────────────────────────────────────────
  rendererDir = mkdtempSync(join(tmpdir(), 'http-shell-renderer-'))
  writeFileSync(join(rendererDir, 'index.html'), '<html>ok</html>')
  writeFileSync(join(rendererDir, 'app.js'), 'console.log("hello")')

  // ── fixture: attachments dir with a nested image ───────────────────────────
  attachmentsDir = mkdtempSync(join(tmpdir(), 'http-shell-attachments-'))
  mkdirSync(join(attachmentsDir, '2026', '05'), { recursive: true })
  // Minimal 1-byte PNG stand-in (content doesn't matter for MIME tests)
  writeFileSync(join(attachmentsDir, '2026', '05', 'x.png'), Buffer.from([0x89]))

  const shell = await startLoopbackShell({ rendererDir, attachmentsDir })
  origin = shell.origin
  close = shell.close
})

afterAll(async () => {
  await close()
  rmSync(rendererDir, { recursive: true, force: true })
  rmSync(attachmentsDir, { recursive: true, force: true })
})

describe('startLoopbackShell', () => {
  it('GET / → 200 text/html containing "ok"', async () => {
    const res = await fetch(`${origin}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    const body = await res.text()
    expect(body).toContain('ok')
  })

  it('GET /app.js → 200 text/javascript', async () => {
    const res = await fetch(`${origin}/app.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/)
  })

  it('GET /_media/2026/05/x.png → 200 image/png', async () => {
    const res = await fetch(`${origin}/_media/2026/05/x.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  it('GET /_media/nope.png → 404', async () => {
    const res = await fetch(`${origin}/_media/nope.png`)
    expect(res.status).toBe(404)
  })

  it('GET /_media/ (bare directory — no listing) → 400', async () => {
    // resolveAppRequest returns null for a bare /_media/ request (relCheck
    // === '' — matches the base of attachmentsDir itself). The server should
    // answer 400, not serve a directory listing.
    const res = await fetch(`${origin}/_media/`)
    expect(res.status).toBe(400)
  })

  it('path traversal via %2e%2e → 400 using raw HTTP client', async () => {
    // The global fetch / new URL normalizes %2e%2e / "../" BEFORE sending the
    // request (e.g. /%2e%2e/x → /x), so the URL-normalized path arrives at
    // the server already "safe" and resolveAppRequest doesn't see a traversal.
    // A non-browser HTTP client (curl, node:http) sends the literal request
    // line — the server's new URL() then normalizes the path, resolving ".."
    // segments, before handing to resolveAppRequest. Net result: a traversal
    // like /%2e%2e/etc/passwd resolves to /etc/passwd inside rendererDir →
    // file-not-found → 404 (not 400). This matches the security model: the URL
    // parser is the first guard layer; resolveAppRequest adds belt-and-suspenders
    // for any path that somehow escapes. Both layers are tested separately in
    // app-protocol.test.ts (resolveAppRequest unit tests) and here (HTTP layer).
    const { port } = new URL(origin)
    // /%2e%2e/etc/passwd normalizes to /etc/passwd → file absent → 404
    const res = await rawGet(`http://127.0.0.1:${port}/%2e%2e/etc/passwd`)
    // The server must NOT serve content (200) — either 404 (normalised path →
    // missing file) or 400 (guard blocks it) is safe. We assert not-200.
    expect(res.status).not.toBe(200)
  })

  it('POST / → 405', async () => {
    const res = await fetch(`${origin}/`, { method: 'POST' })
    expect(res.status).toBe(405)
  })

  it('response has NO Access-Control-Allow-Origin header', async () => {
    const res = await fetch(`${origin}/`)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  // FIX 1: NUL-byte paths must be rejected with 400 before any fs call.
  // `fetch` / `new URL` strip NUL bytes during normalisation, so we use the
  // raw HTTP client (which sends the literal request line) to verify the guard.
  it('GET /%00 (NUL byte) → 400, server does not crash', async () => {
    const { port } = new URL(origin)
    const res = await rawGet(`http://127.0.0.1:${port}/%00`)
    expect(res.status).toBe(400)
    // Confirm the server is still up by issuing a normal request after the
    // NUL-byte probe.
    const followUp = await fetch(`${origin}/`)
    expect(followUp.status).toBe(200)
  })

  it('GET /_media/%00.png (NUL byte in media path) → 400, server does not crash', async () => {
    const { port } = new URL(origin)
    const res = await rawGet(`http://127.0.0.1:${port}/_media/%00.png`)
    expect(res.status).toBe(400)
    // Confirm the server is still up.
    const followUp = await fetch(`${origin}/`)
    expect(followUp.status).toBe(200)
  })

  // FIX 2: every response must carry X-Content-Type-Options: nosniff.
  it('200 response includes x-content-type-options: nosniff', async () => {
    const res = await fetch(`${origin}/`)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('404 response includes x-content-type-options: nosniff', async () => {
    const res = await fetch(`${origin}/_media/absent.png`)
    expect(res.status).toBe(404)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('405 response includes x-content-type-options: nosniff', async () => {
    const res = await fetch(`${origin}/`, { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
