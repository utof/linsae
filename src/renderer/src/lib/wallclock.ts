/**
 * Wall-clock timestamp for chat-style bubbles — the rolling feed (NoteBubble) AND
 * thread notes (Rail). Today → time only ("2:23 PM" / "14:23"); older → short date
 * + time ("May 27, 2:23 PM"). Respects the 12/24h preference via `hour12`.
 *
 * Shared so the feed and the thread render identical timestamps. This is wall-clock
 * (time-of-day); the playback clock (m:ss) lives in lib/time.ts, day grouping in lib/day.ts.
 *
 * @see src/renderer/src/lib/clock-pref.ts (the 12/24h pref + useClock24)
 */
export function formatWallClock(ms: number, hour12: boolean, nowMs: number = Date.now()): string {
  const d = new Date(ms)
  const now = new Date(nowMs)
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12 })
    : d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12,
      })
}
