import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { api } from '../lib/api'

interface Props {
  focusedNoteId: string | null
  onClose: () => void
  onJump: (noteId: string) => void
}

/**
 * Right-side aside listing incoming wikilinks for the focused note,
 * recency-sorted (newest-first) per the spec.
 *
 * Reads `api.links.backlinks(focusedNoteId)` via TanStack Query keyed on the
 * note id — switching focus invalidates nothing but starts a fresh fetch, so
 * the pane re-renders to the new target's backlinks without manual cache work.
 *
 * Empty-state copy: "nothing links here yet." (spec §Empty-state copy).
 *
 * Why early-return `null` when `focusedNoteId` is null (vs always-mounted-but-
 * hidden): always-mounting would keep the `useQuery` subscribed with a stable
 * key and refetch on every focus change anyway, AND it would render the aside
 * frame (border, header chrome) into the layout. The Esc-precedence resolver
 * in spec §Keyboard treats a closed pane as "no pane in the DOM" — App.tsx
 * checks for the pane's presence to decide whether Esc closes it or falls
 * through to other surfaces. Mounting-then-hiding would break that check.
 *
 * Why the clickable `<div>` rows carry `biome-ignore` rather than `<button>`:
 * matches the precedent set by `NoteBubble.tsx:86-87` — feed-style clickable
 * surfaces at v0.1 are mouse-only per spec §Keyboard (no keyboard nav on the
 * backlinks list; jumping happens via palette + wikilink click).
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Right pane
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 28
 * @see src/renderer/src/feed/NoteBubble.tsx
 */
export function BacklinksPane({ focusedNoteId, onClose, onJump }: Props) {
  const { data: notes = [] } = useQuery({
    queryKey: ['backlinks', focusedNoteId],
    queryFn: () => (focusedNoteId ? api.links.backlinks(focusedNoteId) : Promise.resolve([])),
    enabled: !!focusedNoteId,
  })

  if (!focusedNoteId) return null

  return (
    <aside
      style={{
        width: 320,
        flex: '0 0 auto',
        borderLeft: '1px solid var(--border-0)',
        background: 'var(--bg-1)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
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
      <div style={{ overflowY: 'auto', flex: 1, padding: 12 }}>
        {notes.length === 0 && (
          <div style={{ padding: '12px 4px', color: 'var(--fg-3)', fontSize: 12 }}>
            nothing links here yet.
          </div>
        )}
        {notes.map((n) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: backlink rows are mouse-only click targets at v0.1; keyboard nav lives on palette / wikilinks per spec §Keyboard. Mirrors NoteBubble.tsx precedent.
          // biome-ignore lint/a11y/useKeyWithClickEvents: see preceding ignore — no keyboard activation on the row itself; `?` array-access guarded by `?? ''` for noUncheckedIndexedAccess.
          <div
            key={n.id}
            onClick={() => onJump(n.id)}
            style={{
              padding: '10px 14px',
              borderRadius: 6,
              border: '1px solid var(--border-0)',
              background: '#fff',
              marginBottom: 8,
              cursor: 'pointer',
              fontSize: 13,
              color: 'var(--fg-1)',
              lineHeight: 1.5,
            }}
          >
            {(n.body.split('\n')[0] ?? '').slice(0, 100)}
          </div>
        ))}
      </div>
    </aside>
  )
}
