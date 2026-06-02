/**
 * Opt-in YouTube login via cookie import (the yt-dlp `--cookies-from-browser` approach).
 *
 * Google blocks signing in INSIDE an Electron <webview> ("this browser or app may not be
 * secure"), so instead the user logs in with their normal browser, exports the youtube.com
 * cookies as a Netscape `cookies.txt`, and we seed them into the `persist:yt-player`
 * partition. An authenticated session is the highest-trust state YouTube recognises — the
 * hypothesis (being tested) is that it stops both the cold-partition home-bounce and the
 * far-seek segment gating.
 *
 * This is ADDITIVE and opt-in: it only runs if a cookies file exists, and only seeds a
 * partition that is NOT already authenticated (so it never clobbers the live, server-
 * refreshed session cookies on later boots). The unlogged-in/guest path is untouched.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { session } from 'electron'

const PARTITION = 'persist:yt-player'

/** Resolve the cookies file: env override, else the dev `local_files/` location. */
function cookiesPath(): string {
  return (
    process.env.YT_COOKIES_FILE ?? join(process.cwd(), 'local_files', 'cookies-youtube-com.txt')
  )
}

/**
 * Parse one Netscape cookies.txt line → Electron CookiesSetDetails (or null to skip).
 * Format: 7 tab-separated columns `domain  includeSub  path  secure  expiry  name  value`.
 * A leading `#HttpOnly_` marks an HttpOnly cookie; any other `#` line is a comment.
 */
function parseLine(line: string): Electron.CookiesSetDetails | null {
  let httpOnly = false
  let raw = line
  if (raw.startsWith('#HttpOnly_')) {
    httpOnly = true
    raw = raw.slice('#HttpOnly_'.length)
  } else if (raw.startsWith('#') || raw.trim() === '') {
    return null
  }
  const f = raw.split('\t')
  if (f.length < 7) return null
  const domain = f[0] ?? ''
  const path = f[2] || '/'
  const secure = (f[3] ?? '').toUpperCase() === 'TRUE'
  const expiry = Number(f[4])
  const name = f[5] ?? ''
  const value = f.slice(6).join('\t')
  if (!domain || !name) return null
  const host = domain.replace(/^\./, '')
  const details: Electron.CookiesSetDetails = {
    url: `https://${host}${path}`,
    name,
    value,
    path,
    secure,
    httpOnly,
    // no_restriction needs secure; otherwise lax. Maximises the cookie being sent.
    sameSite: secure ? 'no_restriction' : 'lax',
  }
  // __Host- cookies must carry NO domain attribute; everything else keeps it (dot ok).
  if (!name.startsWith('__Host-')) details.domain = domain
  if (Number.isFinite(expiry) && expiry > 0) details.expirationDate = expiry
  return details
}

/**
 * Seed the yt-player partition from a Netscape cookies.txt, once.
 * No-op if the file is absent or the partition is already authenticated.
 * Never logs cookie values.
 */
export async function importYoutubeCookies(): Promise<void> {
  const path = cookiesPath()
  if (!existsSync(path)) return
  const sess = session.fromPartition(PARTITION)
  // Skip if already authenticated: re-importing the (now-stale) file would clobber the
  // live, server-refreshed session cookies and could invalidate the session.
  const already = await sess.cookies.get({ domain: '.youtube.com', name: '__Secure-3PSID' })
  if (already.length > 0) {
    console.log('[main] yt-cookies: partition already authenticated, skipping import')
    return
  }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    console.warn('[main] yt-cookies: read failed', e)
    return
  }
  let ok = 0
  let fail = 0
  for (const line of text.split(/\r?\n/)) {
    const d = parseLine(line)
    if (!d) continue
    try {
      await sess.cookies.set(d)
      ok++
    } catch {
      fail++ // never log the value
    }
  }
  console.log(`[main] yt-cookies imported ok=${ok} fail=${fail} → ${PARTITION}`)
}
