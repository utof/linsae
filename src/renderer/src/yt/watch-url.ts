// watch-url.ts — adapted from media-extended web/url-match/youtube.ts (MIT)
const ID = /^[\w-]{11}$/
export function watchUrl(idOrUrl: string): string {
  if (ID.test(idOrUrl)) return `https://www.youtube.com/watch?v=${idOrUrl}`
  try {
    const u = new URL(idOrUrl)
    const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : (u.searchParams.get('v') ?? '')
    if (id) return `https://www.youtube.com/watch?v=${id}`
  } catch {
    /* not a URL */
  }
  return `https://www.youtube.com/watch?v=${idOrUrl}`
}
