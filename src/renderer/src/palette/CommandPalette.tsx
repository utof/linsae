/**
 * `⌘K` / `Ctrl+K` command palette — `cmdk` `Command.Dialog` driven by SQLite
 * FTS5 search. Parent component owns the global keybind and toggles `open`;
 * this component owns the query state, the IPC fetch (via TanStack Query),
 * and the result list rendering.
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
 * @see docs/specs/v0.1-rolling-feed-and-search.md §User-facing surfaces (⌘K palette)
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 27
 * @see src/main/db/queries/search.ts
 */

import { useQuery } from '@tanstack/react-query'
import { Command } from 'cmdk'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'

interface Props {
  open: boolean
  onClose: () => void
  onJump: (noteId: string) => void
}

export function CommandPalette({ open, onClose, onJump }: Props) {
  const [query, setQuery] = useState('')
  const { data: results = [] } = useQuery({
    queryKey: ['search', query],
    queryFn: () => api.search.run(query),
    enabled: query.length > 0,
  })

  // Reset the query when the palette closes so the next open starts empty
  // (matches v21 palette UX; see command-palette.jsx).
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

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
      <Command.List style={{ maxHeight: 400, overflowY: 'auto', padding: 4 }}>
        {query.length === 0 && (
          <Command.Empty style={{ padding: 12, color: 'var(--fg-3)', fontSize: 12 }}>
            type to search your notes.
          </Command.Empty>
        )}
        {query.length > 0 && results.length === 0 && (
          <Command.Empty style={{ padding: 12, color: 'var(--fg-3)', fontSize: 12 }}>
            no matches.
          </Command.Empty>
        )}
        {results.map((hit) => (
          <Command.Item
            key={hit.note.id}
            value={hit.note.id}
            onSelect={() => {
              onJump(hit.note.id)
              onClose()
            }}
            style={{
              padding: '8px 12px',
              borderRadius: 6,
              fontSize: 13,
              color: 'var(--fg-1)',
              cursor: 'pointer',
            }}
          >
            <span
              // biome-ignore lint/security/noDangerouslySetInnerHtml: snippet() returns pre-tagged <mark> HTML from FTS5; CSP + sandbox mitigate (see TSDoc threat model).
              dangerouslySetInnerHTML={{ __html: hit.snippet }}
            />
          </Command.Item>
        ))}
      </Command.List>
    </Command.Dialog>
  )
}
