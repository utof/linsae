/** Desktop-Firefox-95 UA so YouTube doesn't bot/unsupported-flag the embed (spec §D6).
 *  Copied VERBATIM from aidenlx/media-extended (MIT) — lib/remote-player/ua.ts:11 (Linux),
 *  which has run this exact string in production for years. Do NOT bump the version or
 *  switch to a Chrome UA: empirically a Chrome UA made YouTube bounce the watch page to
 *  its home on EVERY load, and Firefox 144 may be new enough to trip anti-bot — match the
 *  proven reference instead of guessing. media-extended sets it both as the <webview>
 *  `useragent` attribute and via setUserAgent() after dom-ready. */
export function youtubeUserAgent(): string {
  // Sign-in mode (localStorage.ytSignIn='1'): use a CURRENT Chrome UA matched to the engine.
  // Google refuses login on old/Firefox UAs ("this browser may not be secure"); a current
  // Chrome UA is its best shot in an embedded context. Scoped to sign-in so normal playback
  // keeps the proven Firefox UA (a Chrome UA bounced cold playback sessions to home).
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('ytSignIn') === '1') {
      const chrome = navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? 'Chrome/140.0.0.0'
      return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Safari/537.36`
    }
  } catch {
    /* localStorage unavailable — fall through to the default UA */
  }
  return 'Mozilla/5.0 (Linux x86_64; rv:95.0) Gecko/20100101 Firefox/95.0'
}
