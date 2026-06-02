/**
 * Telegram-style date markers for the rolling feed.
 *
 * - {@link DayDivider} — an inline centered date pill rendered above the first note
 *   of each calendar day. It lives inside the virtual-item wrapper, so it scrolls
 *   with the content and is included in the virtualizer's measured item height.
 * - {@link ScrollDatePill} — a floating pill pinned near the top of the scroller that
 *   names the date of the topmost visible note while you scroll, then fades out ~800ms
 *   after scrolling stops. As the next day's inline divider rises into the top zone it
 *   "pushes" this pill up and out (the `push` offset), and the label flips to the new
 *   day exactly as the old pill clears the top — so the two never visibly overlap.
 *
 * Both are presentational; Feed owns the day grouping (lib/day.ts) and the scroll math.
 *
 * @see src/renderer/src/lib/day.ts
 * @see src/renderer/src/feed/Feed.tsx
 */

const pillBase = {
  fontFamily: 'var(--font-sans)',
  fontSize: 11,
  fontWeight: 500,
  padding: '3px 10px',
  borderRadius: 'var(--r-pill)',
  whiteSpace: 'nowrap',
} as const

/** Inline day separator, centered above the first note of a calendar day. */
export function DayDivider({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 0 8px' }}>
      <span
        style={{
          ...pillBase,
          background: 'var(--bg-2)',
          border: '1px solid var(--border-0)',
          color: 'var(--fg-2)',
        }}
      >
        {label}
      </span>
    </div>
  )
}

export interface ScrollDatePillProps {
  /** Date of the topmost visible note. */
  label: string
  /** Pixels to nudge the pill upward as an incoming day divider pushes it out (≥0). */
  push: number
  /** Visible while scrolling; fades to 0 once scrolling stops. */
  visible: boolean
}

/** Floating "scroll date" pill at the top of the feed viewport. @see ScrollDatePillProps */
export function ScrollDatePill({ label, push, visible }: ScrollDatePillProps) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        top: 8,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 3,
        // transform tracks scroll 1:1 (no transition); only opacity eases on idle.
        transform: `translateY(${-push}px)`,
        opacity: visible ? 1 : 0,
        transition: 'opacity 220ms var(--ease-out)',
      }}
    >
      <span
        style={{
          ...pillBase,
          background: 'var(--bg-0)',
          border: '1px solid var(--border-0)',
          color: 'var(--fg-1)',
          boxShadow: 'var(--shadow-2)',
        }}
      >
        {label}
      </span>
    </div>
  )
}
