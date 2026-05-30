/**
 * The `app://` custom-scheme handler that serves the built renderer and, under
 * a reserved `/_media/` prefix, the user's screenshot attachments — replacing
 * the v0.1 `file://` `loadFile` path so the YouTube embed gets a real
 * HTTP-style origin with a non-null Referer (the Error 153 fix, ADR 0008).
 *
 * One host (`bundle`) ⇒ one document origin ⇒ `img-src 'self'` covers both the
 * bundle assets and the `/_media/` attachments; no custom-scheme CSP source.
 *
 * @see docs/specs/v0.2-youtube-annotation.md §App shell migration / §Capture
 * @see https://www.electronjs.org/docs/latest/api/protocol (protocol.handle)
 */

import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'

/** Reserved top-level path that routes to user attachments instead of the bundle. */
const MEDIA_PREFIX = '/_media/'

/**
 * Resolves an `app://bundle/<pathname>` request to an absolute filesystem path,
 * or `null` if the path escapes its root (path-traversal guard) or is a bare
 * directory request. Pure — no I/O — so it is unit-testable.
 *
 * Why the guard: a request like `app://bundle/../../secret` must never read
 * outside the bundle/attachments dirs. Mirrors the official Electron
 * protocol.handle example's `relative()`-based check.
 *
 * Note: the bare-directory rejection (where `relCheck === ''`) applies only to
 * the *root* of each space (i.e. `/` → `rendererDir` itself, `/_media/` →
 * `attachmentsDir` itself). A deeper path that happens to name a directory
 * (e.g. `/_media/sub/`) resolves to a real fs path inside the root and is
 * returned as-is; the `protocol.handle` `net.fetch` layer will 404 on it since
 * it is a directory — that is not a traversal hole because it is still inside
 * the allowed root.
 *
 * @param pathname - The URL pathname (e.g. `/`, `/assets/x.js`, `/_media/y/z.png`).
 * @param roots - Absolute `rendererDir` (built renderer) and `attachmentsDir`.
 * @returns Absolute fs path to serve, or `null` to answer 400.
 */
export function resolveAppRequest(
  pathname: string,
  roots: { rendererDir: string; attachmentsDir: string },
): string | null {
  let baseDir: string
  let rel: string
  if (pathname.startsWith(MEDIA_PREFIX)) {
    baseDir = roots.attachmentsDir
    rel = pathname.slice(MEDIA_PREFIX.length)
  } else {
    baseDir = roots.rendererDir
    rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  }
  const resolved = resolve(baseDir, rel)
  const relCheck = relative(baseDir, resolved)
  const isSafe = relCheck !== '' && !relCheck.startsWith('..') && !isAbsolute(relCheck)
  return isSafe ? resolved : null
}

/**
 * Declares the `app` scheme as privileged. MUST be called at module load time,
 * before `app.whenReady()` — `registerSchemesAsPrivileged` throws if called
 * after ready, and may only be called once.
 *
 * `standard` makes relative URL resolution + a real origin work (needed for the
 * embed referrer); `secure` lets it be treated like https (service workers,
 * secure-context APIs); `supportFetchAPI` lets `net.fetch`/`fetch` target it.
 *
 * @see https://www.electronjs.org/docs/latest/api/protocol (registerSchemesAsPrivileged)
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ])
}

/**
 * Installs the `app://` handler. Call inside `app.whenReady()`. Serves
 * `app://bundle/<asset>` from `rendererDir` and `app://bundle/_media/<path>`
 * from `attachmentsDir`, with a path-traversal guard via {@link resolveAppRequest}.
 *
 * @param rendererDir - Absolute path to the built renderer (`out/renderer`).
 * @param attachmentsDir - Absolute path to `userData/attachments`.
 *
 * @see https://www.electronjs.org/docs/latest/api/protocol (protocol.handle)
 */
export function registerAppProtocol(rendererDir: string, attachmentsDir: string): void {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url)
    const fsPath = resolveAppRequest(decodeURIComponent(pathname), { rendererDir, attachmentsDir })
    if (!fsPath) return new Response('bad request', { status: 400 })
    // net.fetch on a file: URL streams the file with a content-type inferred
    // from its extension; returns 404 automatically if the file is absent.
    return net.fetch(pathToFileURL(fsPath).toString())
  })
}
