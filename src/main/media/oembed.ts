/**
 * YouTube oEmbed metadata fetch (main process, Chrome network stack via
 * net.fetch). oEmbed returns title/author/thumbnail but NO duration (verified
 * against the live endpoint) — duration is filled lazily from the player in
 * Plan 3. Must fail SOFT: a private/unavailable video still yields a working
 * video-note with the raw id as title (spec §Risks: oEmbed unavailability).
 *
 * @see docs/specs/v0.2-youtube-annotation.md §Add a video / §Risks
 */
export interface OEmbedResult {
  title: string
  author_name: string
  author_url: string
  thumbnail_url: string
}

/** Builds the oEmbed JSON endpoint URL for a video id. */
export function oembedUrl(videoId: string): string {
  const watch = `https://www.youtube.com/watch?v=${videoId}`
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`
}

/** Narrows an unknown oEmbed body to the four fields we use, or null. */
export function parseOEmbed(body: unknown): OEmbedResult | null {
  if (!body || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  if (typeof o.title !== 'string') return null
  return {
    title: o.title,
    author_name: typeof o.author_name === 'string' ? o.author_name : '',
    author_url: typeof o.author_url === 'string' ? o.author_url : '',
    thumbnail_url: typeof o.thumbnail_url === 'string' ? o.thumbnail_url : '',
  }
}
