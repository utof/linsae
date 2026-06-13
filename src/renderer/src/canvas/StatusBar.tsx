/**
 * App-wide bottom status strip (spec §14). One hairline, v21-quiet.
 *
 * Feed view: only the `N unplaced ●` indicator (hidden at 0 → clicking opens
 * the shelf). All canvas-specific chrome is hidden.
 *
 * Canvas view (left→right):
 *   `N notes` (placed count)
 *   · zoom pill `87% · fit · 1:1`
 *     — % click → onResetZoom (to 100%)
 *     — fit → onFit (frame all cards)
 *     — 1:1 shown only when zoomPct ≠ 100, click → onResetZoom
 *     — pill fades to 40% opacity when idle (CSS transition)
 *   · `recent ▴` trigger → onToggleRecent
 *   · right edge `N unplaced ●` (hidden at 0) → onOpenShelf
 *
 * Positioned by App (Task 10) as the app-wide footer — below the body row.
 * RecentPopover is a sibling rendered by App with `position:absolute` above
 * the status bar when `recentOpen` is true.
 *
 * Why separate StatusBar + RecentPopover components: App owns `recentOpen`
 * state and positions the popover itself (Task 10 binding seam — not latitude).
 *
 * @see docs/specs/v0.4-canvas-mvp.md §14
 */

interface Props {
  /** Which view the app is currently showing. */
  view: 'feed' | 'canvas'
  /** Number of notes with x/y coords (placed). */
  placedCount: number
  /** Number of notes with null x/y (shelved, unplaced). */
  unplacedCount: number
  /** Current zoom level as a whole percentage (e.g. 87 = 87%). */
  zoomPct: number
  /** Open the shelf / dock. */
  onOpenShelf: () => void
  /** Reset zoom to 100% (both % readout and `1:1` button). */
  onResetZoom: () => void
  /** Frame all placed cards (zoom-to-fit). */
  onFit: () => void
  /** Toggle the recent popover open/closed. */
  onToggleRecent: () => void
}

/** Quiet pill button used inside the zoom cluster. */
function PillBtn({
  label,
  onClick,
  title,
}: {
  label: string
  onClick: () => void
  title?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      style={{
        background: 'none',
        border: 'none',
        padding: '0 4px',
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--t-12)',
        color: 'var(--fg-2)',
        lineHeight: 1,
      }}
    >
      {label}
    </button>
  )
}

/**
 * The `N unplaced ●` dot indicator — clickable, hidden at 0.
 * @see docs/specs/v0.4-canvas-mvp.md §14 (placement debt)
 */
function UnplacedIndicator({
  count,
  onOpenShelf,
}: {
  count: number
  onOpenShelf: () => void
}): React.JSX.Element | null {
  if (count === 0) return null
  return (
    <button
      type="button"
      aria-label={`${count} unplaced — open shelf`}
      onClick={onOpenShelf}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 'var(--t-12)',
        fontFamily: 'var(--font-sans)',
        color: 'var(--fg-2)',
        cursor: 'pointer',
        userSelect: 'none',
        padding: '2px 6px',
        borderRadius: 'var(--r-1)',
        background: 'none',
        border: 'none',
      }}
    >
      {count} unplaced ●
    </button>
  )
}

/**
 * App-wide bottom status bar. Mounts always; content varies by `view`.
 * @see docs/specs/v0.4-canvas-mvp.md §14
 */
export function StatusBar({
  view,
  placedCount,
  unplacedCount,
  zoomPct,
  onOpenShelf,
  onResetZoom,
  onFit,
  onToggleRecent,
}: Props): React.JSX.Element {
  return (
    <div
      data-status-bar
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 28,
        paddingLeft: 12,
        paddingRight: 12,
        borderTop: '1px solid var(--border-0)',
        background: 'var(--bg-1)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--t-12)',
        color: 'var(--fg-2)',
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {view === 'feed' ? (
        // Feed view: only the unplaced indicator (right edge)
        <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
          <UnplacedIndicator count={unplacedCount} onOpenShelf={onOpenShelf} />
        </div>
      ) : (
        // Canvas view: left cluster · zoom pill · recent · right unplaced
        <>
          {/* Left: placed count */}
          <span
            style={{
              fontSize: 'var(--t-12)',
              color: 'var(--fg-2)',
              whiteSpace: 'nowrap',
            }}
          >
            {placedCount} notes
          </span>

          {/* Center cluster: zoom pill + recent trigger */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
            }}
          >
            {/* Zoom pill */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                padding: '2px 6px',
                borderRadius: 'var(--r-1)',
                border: '1px solid var(--border-0)',
                background: 'var(--bg-0)',
              }}
            >
              {/* % readout — click resets to 100% */}
              <button
                type="button"
                onClick={onResetZoom}
                aria-label={`${zoomPct}% — reset zoom`}
                style={{
                  fontSize: 'var(--t-12)',
                  fontFamily: 'var(--font-sans)',
                  color: 'var(--fg-1)',
                  cursor: 'pointer',
                  padding: '0 2px',
                  background: 'none',
                  border: 'none',
                }}
              >
                {zoomPct}%
              </button>
              <span style={{ color: 'var(--fg-4)', padding: '0 2px' }}>·</span>
              <PillBtn label="fit" onClick={onFit} title="zoom to fit all cards" />
              {zoomPct !== 100 && (
                <>
                  <span style={{ color: 'var(--fg-4)', padding: '0 2px' }}>·</span>
                  <PillBtn label="1:1" onClick={onResetZoom} title="reset to 100%" />
                </>
              )}
            </div>

            {/* Recent trigger */}
            <button
              type="button"
              aria-label="recent"
              onClick={onToggleRecent}
              style={{
                background: 'none',
                border: 'none',
                padding: '2px 8px',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--t-12)',
                color: 'var(--fg-2)',
              }}
            >
              recent <span aria-hidden="true">▴</span>
            </button>
          </div>

          {/* Right: unplaced indicator */}
          <UnplacedIndicator count={unplacedCount} onOpenShelf={onOpenShelf} />
        </>
      )}
    </div>
  )
}
