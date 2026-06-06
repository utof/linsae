/**
 * Time-of-day timestamp for chat-style bubbles — the rolling feed (NoteBubble +
 * video card) and thread notes (Rail). Always time only ("2:23 PM" / "14:23"),
 * never a date: every surface that uses it now has day dividers that carry the date,
 * so repeating it on each bubble would be redundant. Respects the 12/24h pref via `hour12`.
 *
 * Wall-clock (time-of-day); the playback clock (m:ss) lives in lib/time.ts, day
 * grouping in lib/day.ts.
 *
 * @see src/renderer/src/lib/clock-pref.ts (the 12/24h pref + useClock24)
 */
export function formatTimeOnly(ms: number, hour12: boolean): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12 })
}
