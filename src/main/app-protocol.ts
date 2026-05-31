/**
 * Pure request-path resolver for the linsae renderer bundle and `/_media/`
 * attachment routing, shared by the loopback HTTP shell
 * ({@link ./http-shell.ts | startLoopbackShell}).
 *
 * This module is intentionally electron-free — it imports only `node:path` —
 * so it can be imported by `http-shell.ts`, which in turn is imported by
 * `electron.vite.config.ts` at config-eval time (plain Node, no Electron).
 *
 * Why keep this separate from `http-shell.ts`: the resolver logic + its tests
 * have no dependency on the HTTP server machinery and can be unit-tested
 * without starting a server.
 *
 * @see src/main/http-shell.ts (loopback HTTP shell that calls this)
 * @see docs/specs/v0.2-localhost-shell.md §2 (loopback shell decision)
 */

import { isAbsolute, relative, resolve } from 'node:path'

/** Reserved top-level path that routes to user attachments instead of the bundle. */
const MEDIA_PREFIX = '/_media/'

/**
 * Resolves a request pathname to an absolute filesystem path, or `null` if
 * the path escapes its root (path-traversal guard) or is a bare directory
 * request. Pure — no I/O — so it is unit-testable.
 *
 * Why the guard: a request like `/../../secret` must never read outside the
 * bundle/attachments dirs. Mirrors the official Electron protocol.handle
 * example's `relative()`-based check.
 *
 * Note: the bare-directory rejection (where `relCheck === ''`) applies only to
 * the *root* of each space (i.e. `/` → `rendererDir` itself, `/_media/` →
 * `attachmentsDir` itself). A deeper path that happens to name a directory
 * (e.g. `/_media/sub/`) resolves to a real fs path inside the root and is
 * returned as-is; the caller's `createReadStream` will produce EISDIR → 404.
 * That is not a traversal hole because it is still inside the allowed root.
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
