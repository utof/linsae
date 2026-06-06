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

/**
 * Parses a bare digit string (colons stripped) into seconds, reading
 * right-to-left: last two digits = seconds, next two = minutes, the rest =
 * hours. So `1234` → 12:34, `123` → 1:23, `5` → 0:05, `12345` → 1:23:45.
 *
 * Why right-to-left: lets the composer chip accept fast keyboard entry without
 * a colon (`1234`) while staying unambiguous — the smallest unit is always
 * pinned to the right, exactly like a stopwatch / phone time field.
 *
 * Over-60 minute/second segments are NOT rejected here (e.g. `90` seconds);
 * they carry into the total and `formatClock` normalises the display. Always
 * returns a non-negative integer (empty / non-digit input → 0).
 *
 * @see docs/specs/v0.2-youtube-annotation.md §Composer
 */
export function parseTimeDigits(digits: string): number {
  const d = digits.replace(/\D/g, '')
  if (!d) return 0
  const ss = Number(d.slice(-2))
  const mm = Number(d.slice(-4, -2) || '0')
  const hh = Number(d.slice(0, -4) || '0')
  return hh * 3600 + mm * 60 + ss
}

/** Clamps `seconds` into `[0, max]`; when `max` is null/≤0 only the lower bound applies. */
export function clampSeconds(seconds: number, max: number | null): number {
  const lo = Math.max(0, seconds)
  return max != null && max > 0 ? Math.min(lo, max) : lo
}
