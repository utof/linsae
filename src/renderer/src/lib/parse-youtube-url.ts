/**
 * Extracts a YouTube video ID from arbitrary text.
 *
 * Handles three URL forms that appear in user-pasted text:
 *   - watch:    https://[www.]youtube.com/watch?v=<ID>[&...]
 *   - short:    https://youtu.be/<ID>[?...]
 *   - embed:    https://[www.]youtube[-nocookie].com/embed/<ID>[/...]
 *
 * Why: Users paste YouTube links directly into note bodies; the capture
 * flow must reliably recover the 11-character video ID regardless of
 * surrounding prose, query parameters, or cookie-free embed variants.
 *
 * @see docs/specs/v0.2-youtube-annotation.md §Add a video
 * @param text - Raw string that may contain a YouTube URL anywhere.
 * @returns The 11-character video ID, or `null` if no YouTube URL is found.
 */
export function parseYouTubeUrl(text: string): string | null {
  // Regex explanation:
  //   (?<![\w-])
  //     left-boundary so the host must START a domain label — rejects lookalike
  //     domains like `notyoutu.be` / `soyoutube.com` (preceded by a word char),
  //     while still allowing scheme/`www.`/subdomain/space/start prefixes
  //   (?:youtu\.be/|(?:youtube(?:-nocookie)?\.com)/(?:watch\?(?:\S*?&)*?v=|embed/))
  //     matches the host+path prefix for all three supported URL forms
  //   ([A-Za-z0-9_-]{11})
  //     captures exactly the 11-character video ID (YouTube's fixed-length format)
  const RE =
    /(?<![\w-])(?:youtu\.be\/|(?:youtube(?:-nocookie)?\.com)\/(?:watch\?(?:\S*?&)*?v=|embed\/))([A-Za-z0-9_-]{11})/

  const match = RE.exec(text)
  return match?.[1] ?? null
}
