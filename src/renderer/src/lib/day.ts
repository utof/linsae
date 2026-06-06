/**
 * Calendar-day helpers for the feed's Telegram-style date separators + floating
 * "scroll date" pill (Feed.tsx). These work on local calendar days, NOT UTC — a
 * note written at 11pm and one at 1am the next morning belong to different
 * separators for the user, regardless of timezone offset.
 *
 * Why a separate module (not lib/time.ts): lib/time.ts is about the *playback*
 * clock (m:ss / h:mm:ss); this is wall-clock calendar grouping. Different domain,
 * different consumers.
 *
 * @see src/renderer/src/feed/Feed.tsx (date separators + scroll pill)
 */

/** ms in one day — used only for the relative today/yesterday delta. */
const DAY_MS = 86_400_000

/** Midnight (local) of the day containing `ms`, as epoch ms. */
function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * Stable per-day key for grouping (local `year-month-day`). Two timestamps share
 * a key iff they fall on the same local calendar day. Used to detect day
 * boundaries between adjacent notes in the feed.
 */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/**
 * Human label for a day separator / scroll pill: `today` / `yesterday` for the
 * two most recent days (lowercase to match the v21 voice), otherwise the locale
 * month-day (`June 2`), with the year appended only when it differs from `now`'s
 * year (`June 2, 2024`).
 *
 * @param ms   the timestamp whose day to label.
 * @param nowMs reference "now" (defaults to the live clock); injectable so tests
 *   are deterministic.
 */
export function formatDayLabel(ms: number, nowMs: number = Date.now()): string {
  const diffDays = Math.round((startOfLocalDay(nowMs) - startOfLocalDay(ms)) / DAY_MS)
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear()
  return d.toLocaleDateString(
    undefined,
    sameYear
      ? { month: 'long', day: 'numeric' }
      : { month: 'long', day: 'numeric', year: 'numeric' },
  )
}
