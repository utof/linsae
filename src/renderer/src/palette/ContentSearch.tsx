/**
 * `⌘P` / `Ctrl+P` content search — `cmdk` `Command.Dialog` driven by SQLite
 * FTS5 search. Parent component owns the global keybind and toggles `open`;
 * this component owns the query state, the IPC fetch (via TanStack Query),
 * and the result list rendering. Empty query → recent/frecent rows
 * (`notes:recent`, mode from the `notes.recencyMode` setting); typing runs FTS
 * and renders title + `snippet()`-highlighted rows (spec §6).
 *
 * Why `shouldFilter={false}`: FTS5 already ranks results server-side via
 * `bm25()` (see src/main/db/queries/search.ts) and returns `snippet()`-
 * highlighted excerpts. Letting cmdk re-filter the small returned set against
 * the raw query string would discard FTS5's tokenizer + ranking, replacing it
 * with cmdk's `command-score` fuzzy matcher — which strips the `<mark>` tags
 * and would frequently drop hits whose body matches via stemming but whose
 * displayed snippet does not contain the literal query.
 *
 * Why `dangerouslySetInnerHTML` for snippet rendering: `snippet()` returns
 * pre-tagged HTML wrapping matches with the configured `<mark>...</mark>`
 * delimiters (see src/main/db/queries/search.ts:62). Rendering as text would
 * surface the literal `<mark>` characters; using `dangerouslySetInnerHTML`
 * preserves the highlight markup. **Threat model:** the snippet content is
 * derived from user-stored note bodies, which may contain arbitrary HTML the
 * user typed/imported. SQLite's `snippet()` only wraps tokenised matches —
 * it does NOT escape surrounding text. The renderer runs with
 * `contextIsolation: true` + `sandbox: true` (Task 21) and the CSP forbids
 * inline scripts (spec §329), so `<script>` payloads cannot execute. Other
 * vectors (`<img onerror=...>`, `<iframe>`) remain possible. Tracked for a
 * follow-up DOMPurify pass; the v0.1 plan accepts this risk explicitly.
 *
 * @see docs/specs/v0.5-command-search.md §6
 * @see src/renderer/src/palette/QuickSwitcher.tsx (sibling — same recent/frecent empty-state pipe)
 * @see src/main/db/queries/search.ts
 */

import { useQuery } from '@tanstack/react-query'
import { Command } from 'cmdk'
import { useEffect, useState } from 'react'
import { ScrollArea } from '../components/ScrollArea'
import { api } from '../lib/api'
import { useSetting } from '../lib/use-setting'

interface Props {
  open: boolean
  onClose: () => void
  onJump: (noteId: string) => void
}

export function ContentSearch({ open, onClose, onJump }: Props) {
  const [query, setQuery] = useState('')
  const mode = useSetting<'recent' | 'frecent'>('notes.recencyMode', 'frecent')
  const { data: results = [] } = useQuery({
    queryKey: ['search', query],
    queryFn: () => api.search.run(query),
    enabled: query.length > 0,
  })
  // Empty-query recents — ordered by the recencyMode setting (recent | frecent).
  // Same query pattern as QuickSwitcher.tsx for consistency.
  const { data: recent = [] } = useQuery({
    queryKey: ['note-recent', mode],
    queryFn: () => api.notes.recent(mode, 15),
    enabled: open,
  })

  // Reset the query when the palette closes so the next open starts empty
  // (matches v21 palette UX; see command-palette.jsx).
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  function select(id: string) {
    onJump(id)
    onClose()
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      label="search"
      shouldFilter={false}
      style={{
        position: 'fixed',
        top: '20%',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 600,
        maxWidth: '90vw',
        background: '#fff',
        border: '1px solid var(--border-0)',
        borderRadius: 10,
        boxShadow: 'var(--shadow-3)',
        fontFamily: 'var(--font-sans)',
        zIndex: 100,
      }}
    >
      <Command.Input
        value={query}
        onValueChange={setQuery}
        placeholder="type to search your notes."
        style={{
          width: '100%',
          border: 0,
          outline: 'none',
          padding: '12px 16px',
          fontSize: 14,
          fontFamily: 'var(--font-sans)',
          borderBottom: '1px solid var(--border-0)',
        }}
      />
      {/* ScrollArea wraps the results list with our custom thumb overlay.
         maxHeight on the outer ScrollArea bounds the dialog height;
         scrollStyle.padding adds the inner padding the previous
         Command.List inline style used. cmdk's Command.List still
         renders inside but doesn't own scrolling now. */}
      <ScrollArea style={{ maxHeight: 400 }} scrollStyle={{ padding: 4 }}>
        <Command.List>
          {/* Empty query → recent/frecent rows (jump like the FTS rows). */}
          {query.length === 0 && recent.length === 0 && (
            <Command.Empty style={{ padding: 12, color: 'var(--fg-3)', fontSize: 12 }}>
              no recent notes.
            </Command.Empty>
          )}
          {query.length === 0 &&
            recent.map((r) => (
              <Command.Item
                key={r.id}
                value={r.id}
                onSelect={() => select(r.id)}
                style={{
                  padding: '8px 12px',
                  borderRadius: 6,
                  fontSize: 13,
                  color: 'var(--fg-1)',
                  cursor: 'pointer',
                }}
              >
                {r.title}
              </Command.Item>
            ))}
          {query.length > 0 && results.length === 0 && (
            <Command.Empty style={{ padding: 12, color: 'var(--fg-3)', fontSize: 12 }}>
              no matches.
            </Command.Empty>
          )}
          {query.length > 0 &&
            results.map((hit) => (
              <Command.Item
                key={hit.note.id}
                value={hit.note.id}
                onSelect={() => select(hit.note.id)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  padding: '8px 12px',
                  borderRadius: 6,
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg-1)' }}>
                  {hit.title}
                </div>
                <span
                  style={{ fontSize: 12, color: 'var(--fg-2)' }}
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: snippet() returns pre-tagged <mark> HTML from FTS5; CSP + sandbox mitigate (see TSDoc threat model).
                  dangerouslySetInnerHTML={{ __html: hit.snippet }}
                />
              </Command.Item>
            ))}
        </Command.List>
      </ScrollArea>
    </Command.Dialog>
  )
}
