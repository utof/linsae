/** Desktop-Firefox-class UA so YouTube doesn't bot/unsupported-flag the embed (spec §D6).
 *  Adapted from aidenlx/media-extended (MIT) — lib/remote-player/ua.ts. */
export function youtubeUserAgent(): string {
  return 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0'
}
