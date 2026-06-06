/** Desktop-Firefox-95 UA so YouTube doesn't bot/unsupported-flag the embed (spec §D6).
 *  Copied VERBATIM from aidenlx/media-extended (MIT) — lib/remote-player/ua.ts:11 (Linux),
 *  which has run this exact string in production for years. Do NOT bump the version or
 *  switch to a Chrome UA: empirically a Chrome UA made YouTube bounce the watch page to
 *  its home on EVERY load, and Firefox 144 may be new enough to trip anti-bot — match the
 *  proven reference instead of guessing. media-extended sets it both as the <webview>
 *  `useragent` attribute and via setUserAgent() after dom-ready. */
export function youtubeUserAgent(): string {
  return 'Mozilla/5.0 (Linux x86_64; rv:95.0) Gecko/20100101 Firefox/95.0'
}
