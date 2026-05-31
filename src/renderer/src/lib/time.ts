/**
 * Playback-clock formatting for the transport bar, rail timestamps, the composer
 * chip, and MediaFeedNote durations. `m:ss` under an hour, `h:mm:ss` at/over.
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView / §Composer
 */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Parses `m:ss` or `h:mm:ss` to seconds, or null if malformed (seconds 00-59). */
export function parseClock(text: string): number | null {
  const m = text.trim().match(/^(?:(\d+):)?(\d{1,2}):([0-5]\d)$/)
  if (!m) return null
  const [, h, mm, ss] = m
  return (h ? Number(h) * 3600 : 0) + Number(mm) * 60 + Number(ss)
}
