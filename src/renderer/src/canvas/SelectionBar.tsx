/**
 * Floating quiet action bar shown when one or more canvas cards are selected.
 *
 * Purely presentational: placement (absolute position within the viewport) is
 * CanvasStage's responsibility. This component owns only the two verbs:
 * - "remove from canvas" — removes the layout row(s); notes stay in the feed.
 * - "delete note…" — requests a confirm dialog (App-owned native confirm);
 *   the ellipsis is intentional: the action is destructive and delegates to
 *   the parent for confirmation.
 *
 * Key bindings (⌫ / ⌦ for remove) are wired at the CanvasStage level (Task 8)
 * — this bar is one of two entry points, not the sole one.
 *
 * Why position:absolute here: the bar must sit inside the canvas viewport
 * overlay stack and float above cards. CanvasStage positions it via inline
 * top/left/transform when mounting.
 *
 * @see docs/plans/v0.4-canvas-mvp-3-placement-chrome.md Task 7
 * @see docs/specs/v0.4-canvas-mvp.md §8
 */
export function CanvasSelectionBar({
  count,
  onRemove,
  onDeleteRequest,
}: {
  count: number
  onRemove: () => void
  onDeleteRequest: () => void
}): React.ReactElement | null {
  if (count === 0) return null

  return (
    <div
      style={{
        position: 'absolute',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: 'var(--bg-1)',
        border: '1px solid var(--border-0)',
        borderRadius: 8,
        padding: '4px 8px',
        boxShadow: 'var(--shadow-1)',
        pointerEvents: 'auto',
      }}
    >
      <span
        style={{
          fontSize: 12,
          color: 'var(--fg-2)',
          padding: '2px 6px',
          whiteSpace: 'nowrap',
        }}
      >
        {count} selected
      </span>
      <div
        style={{ width: 1, height: 16, background: 'var(--border-0)', margin: '0 2px' }}
        aria-hidden="true"
      />
      <button
        type="button"
        onClick={onRemove}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          border: 0,
          background: 'transparent',
          borderRadius: 6,
          padding: '4px 8px',
          fontFamily: 'var(--font-sans)',
          fontSize: 12,
          color: 'var(--fg-1)',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        remove from canvas
      </button>
      <button
        type="button"
        onClick={onDeleteRequest}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          border: 0,
          background: 'transparent',
          borderRadius: 6,
          padding: '4px 8px',
          fontFamily: 'var(--font-sans)',
          fontSize: 12,
          color: 'var(--fg-danger, #E5484D)',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        delete note…
      </button>
    </div>
  )
}
