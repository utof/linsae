/**
 * Loopback HTTP shell: serves the built renderer bundle and `/_media/` user
 * attachments over `http://127.0.0.1:<port>` so the YouTube IFrame embed gets
 * a valid `http://` document origin (required — `app://` is rejected with
 * Error 153/152 exactly as Tauri's `tauri://` is; see ADR 0008).
 *
 * Security posture (port-only baseline, per §7 I1 of the spec):
 *   - Bound to 127.0.0.1 only (never 0.0.0.0).
 *   - Ephemeral port in prod (listen(0)); fixed DEV_MEDIA_PORT in dev.
 *   - GET-only (405 otherwise).
 *   - Path-traversal guard via {@link resolveAppRequest} (400 on escape).
 *   - No directory listing (EISDIR → 404).
 *   - No Access-Control-Allow-Origin header (prevents cross-origin JS reads).
 *
 * Why no `electron` import: `electron.vite.config.ts` does
 * `import { DEV_MEDIA_PORT } from './src/main/http-shell'` at config-eval time
 * which runs in plain Node outside Electron; importing `electron` here would
 * throw. Only `node:http`, `node:fs`, `node:path`, `node:url` and the pure
 * `resolveAppRequest` (also electron-free after L5) are allowed.
 *
 * @see adrs/0008-loopback-http-shell.md
 * @see src/main/app-protocol.ts (resolveAppRequest — pure path resolver)
 * @see docs/specs/v0.2-localhost-shell.md §2
 */

import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { extname } from 'node:path'
import { resolveAppRequest } from './app-protocol'

/**
 * Fixed loopback port used when the dev Vite server is running
 * (`ELECTRON_RENDERER_URL` is set). Statically importable from
 * `electron.vite.config.ts` (plain-Node context, no Electron).
 *
 * Why 37623: an arbitrary high ephemeral-range port unlikely to collide with
 * common dev services. The value is also set in the vite dev-server proxy so
 * `/_media/...` requests from the renderer are forwarded here.
 */
export const DEV_MEDIA_PORT = 37623

/** Extension → MIME type map for the renderer bundle assets. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

/**
 * Starts the loopback HTTP shell.
 *
 * @param rendererDir - Absolute path to the built renderer (`out/renderer` in
 *   prod; unused in dev since the vite server owns the document origin but the
 *   shell still serves `/_media/`).
 * @param attachmentsDir - Absolute path to `userData/attachments`.
 * @param port - Optional fixed port (pass `DEV_MEDIA_PORT` in dev). When
 *   omitted the OS assigns an ephemeral port via `listen(0)`.
 * @returns `{ origin, close }` — `origin` is the `http://127.0.0.1:<port>`
 *   string to pass to `loadURL`; `close()` drains in-flight requests and
 *   resolves when the server is fully shut down.
 *
 * Why server-must-be-up before loadURL: if `loadURL` is called before
 * `listen` resolves, the renderer's very first GET returns ECONNREFUSED and
 * the window shows a blank error page. Awaiting `startLoopbackShell` ensures
 * the socket is bound.
 *
 * @see docs/specs/v0.2-localhost-shell.md §4 L2 + §7 B1/B3
 */
export function startLoopbackShell({
  rendererDir,
  attachmentsDir,
  port,
}: {
  rendererDir: string
  attachmentsDir: string
  port?: number
}): Promise<{ origin: string; close(): Promise<void> }> {
  return new Promise((resolveShell, rejectShell) => {
    const server = createServer((req, res) => {
      // GET-only gate.
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET', 'X-Content-Type-Options': 'nosniff' })
        res.end('Method Not Allowed')
        return
      }

      // Resolve the pathname to an absolute fs path.
      const rawUrl = req.url ?? '/'
      // Build a base origin string for URL parsing (the real origin is set
      // after listen, but we only need pathname resolution here).
      const base = 'http://127.0.0.1'
      let pathname: string
      try {
        pathname = new URL(rawUrl, base).pathname
      } catch {
        res.writeHead(400, { 'X-Content-Type-Options': 'nosniff' })
        res.end('Bad Request')
        return
      }

      const decoded = decodeURIComponent(pathname)

      // Reject NUL bytes before any fs access.  `createReadStream` throws
      // synchronously (ERR_INVALID_ARG_VALUE) for NUL-containing paths, and
      // that happens before the 'error' listener is attached → uncaughtException
      // → main-process crash.  Belt-and-suspenders: also guard here so we reply
      // 400 cleanly instead of crashing.
      // Why NUL is the trigger: NUL passes the traversal guard (it is not ".."),
      // but every POSIX fs call treats it as a string terminator and throws.
      if (decoded.includes('\0')) {
        res.writeHead(400, { 'X-Content-Type-Options': 'nosniff' })
        res.end('Bad Request')
        return
      }

      const fsPath = resolveAppRequest(decoded, { rendererDir, attachmentsDir })
      if (!fsPath) {
        res.writeHead(400, { 'X-Content-Type-Options': 'nosniff' })
        res.end('Bad Request')
        return
      }

      // Key the MIME off the resolved fs path extension (so `/` → `index.html`
      // → `text/html`, not `application/octet-stream` for empty extension).
      const ext = extname(fsPath).toLowerCase()
      const contentType = MIME[ext] ?? 'application/octet-stream'

      // Wrap createReadStream creation in try/catch so any other synchronous
      // fs throw (e.g. a future Node version that adds new synchronous checks)
      // cannot propagate past the request handler and crash the main process.
      // The async 'error' handler below still covers ENOENT / EISDIR / etc.
      let stream: ReturnType<typeof createReadStream>
      try {
        stream = createReadStream(fsPath)
      } catch {
        res.writeHead(400, { 'X-Content-Type-Options': 'nosniff' })
        res.end('Bad Request')
        return
      }
      stream.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'EISDIR') {
          res.writeHead(404, { 'X-Content-Type-Options': 'nosniff' })
          res.end('Not Found')
        } else {
          res.writeHead(500, { 'X-Content-Type-Options': 'nosniff' })
          res.end('Internal Server Error')
        }
      })
      stream.once('open', () => {
        res.writeHead(200, { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' })
        stream.pipe(res)
      })
    })

    server.once('error', rejectShell)

    server.listen(port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        rejectShell(new Error('http-shell: unexpected address type'))
        return
      }
      const origin = `http://127.0.0.1:${addr.port}`
      resolveShell({
        origin,
        close(): Promise<void> {
          return new Promise((r) => server.close(() => r()))
        },
      })
    })
  })
}
