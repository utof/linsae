import { X } from 'lucide-react'
import { BacklinksContext } from './BacklinksContext'
import { BacklinksPaneBody } from './BacklinksPaneBody'

interface Props {
  focusedNoteId: string | null
  onClose: () => void
  onJump: (noteId: string) => void
}

/**
 * Right-side aside chrome (header + close button) for the backlinks list;
 * the list itself lives in {@link BacklinksPaneBody}, fed via BacklinksContext.
 *
 * Positioned as an absolute overlay (parent must be `position: relative` —
 * App.tsx wraps the body row accordingly). The pane covers the right edge
 * of the feed area without pushing the feed left when it opens, per user
 * feedback ("the shift is annoying and too much for such a small action").
 * The WindowFrame above stays visible because the overlay is scoped to the
 * body row only.
 *
 * Why early-return `null` when `focusedNoteId` is null (vs always-mounted-but-
 * hidden): always-mounting would render the aside frame (border, header chrome)
 * into the layout, and (via the mounted body) keep a `useQuery` subscribed. The
 * Esc-precedence resolver in spec §Keyboard treats a closed pane as "no pane in
 * the DOM" — App.tsx checks for the pane's presence to decide whether Esc closes
 * it or falls through to other surfaces. Mounting-then-hiding would break that
 * check.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Right pane
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 28
 */
export function BacklinksPane({ focusedNoteId, onClose, onJump }: Props) {
  if (!focusedNoteId) return null
  return (
    <BacklinksContext.Provider value={{ focusedId: focusedNoteId, onJump }}>
      <aside
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 320,
          borderLeft: '1px solid var(--border-0)',
          background: 'var(--bg-1)',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '-4px 0 12px rgba(0, 0, 0, 0.04)',
          zIndex: 10,
        }}
      >
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--border-0)',
            background: '#fff',
            minHeight: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: 'var(--fg-2)',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              fontWeight: 500,
            }}
          >
            backlinks
          </div>
          <button
            type="button"
            title="close pane"
            aria-label="close pane"
            onClick={onClose}
            style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 4 }}
          >
            <X size={14} />
          </button>
        </div>
        <BacklinksPaneBody />
      </aside>
    </BacklinksContext.Provider>
  )
}
