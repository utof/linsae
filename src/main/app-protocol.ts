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
