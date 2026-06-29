import { useQuery } from '@tanstack/react-query'
import { ScrollArea } from '../components/ScrollArea'
import { api } from '../lib/api'
import { useBacklinks } from './BacklinksContext'

/** The backlinks list — incoming wikilinks for the focused note, newest-first.
 *  Prop-free: reads {focusedId,onJump} from BacklinksContext so it renders
 *  identically in the overlay (BacklinksPane) and the dock pane (Pane registry).
 *  Reads `api.links.backlinks(focusedId)` via TanStack Query keyed on the note
 *  id — switching focus starts a fresh fetch with no manual cache work. Empty
 *  state: "nothing links here yet." (spec §Empty-state copy).
 *  @see docs/specs/v0.6.2-dock-shell.md §3 */
export function BacklinksPaneBody(): React.JSX.Element {
  const { focusedId, onJump } = useBacklinks()
  const { data: notes = [] } = useQuery({
    queryKey: ['backlinks', focusedId],
    queryFn: () => (focusedId ? api.links.backlinks(focusedId) : Promise.resolve([])),
    enabled: !!focusedId,
  })
  return (
    <ScrollArea style={{ flex: 1, minHeight: 0 }} scrollStyle={{ padding: 12 }}>
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
    </ScrollArea>
  )
}
