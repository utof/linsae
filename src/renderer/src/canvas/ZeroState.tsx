/**
 * Zero-state overlay for the canvas: shown when zero cards are placed.
 * Centered in the viewport (the parent renders `position:absolute; inset:0;
 * display:grid; place-items:center`). Keys off `visible` — the caller passes
 * `placedLayouts.length === 0`. Returns null when not visible so the surface
 * is empty and this component has zero cost.
 *
 * Copy is verbatim per spec §14; never edit without updating the spec.
 *
 * Why: curated start means the canvas is empty at first run; the user needs
 * a nudge to discover placement. The message disappears as soon as any card
 * is placed (no stored flag — spec §14 binding rule).
 *
 * @see docs/specs/v0.4-canvas-mvp.md §14
 */

interface Props {
  /** Show when true (caller: `placedLayouts.length === 0`). */
  visible: boolean
}

/**
 * Verbatim zero-state copy for the canvas first-run surface.
 * Why: spec §14 declares the exact strings; paraphrasing would be a spec
 * violation and break the test assertions.
 */
export function ZeroState({ visible }: Props): React.JSX.Element | null {
  if (!visible) return null
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: '24px 32px',
        borderRadius: 'var(--r-4)',
        background: 'var(--bg-1)',
        border: '1px solid var(--border-0)',
        textAlign: 'center',
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      <span
        style={{
          fontSize: 'var(--t-14)',
          fontFamily: 'var(--font-sans)',
          fontWeight: 500,
          color: 'var(--fg-0)',
        }}
      >
        nothing here yet.
      </span>
      <span
        style={{
          fontSize: 'var(--t-13)',
          fontFamily: 'var(--font-sans)',
          color: 'var(--fg-2)',
          lineHeight: 'var(--lh-snug)',
        }}
      >
        this canvas only shows what you place on it.
      </span>
      <span
        style={{
          fontSize: 'var(--t-13)',
          fontFamily: 'var(--font-sans)',
          color: 'var(--fg-2)',
          lineHeight: 'var(--lh-snug)',
        }}
      >
        double-click to write something here,
      </span>
      <span
        style={{
          fontSize: 'var(--t-13)',
          fontFamily: 'var(--font-sans)',
          color: 'var(--fg-3)',
          lineHeight: 'var(--lh-snug)',
        }}
      >
        or press / to bring a note over from the feed
      </span>
    </div>
  )
}
