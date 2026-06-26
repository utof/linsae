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
 * Why the fuzzy-title fallback: when FTS yields nothing (no body/slug token
 * matches the query — e.g. `cu` is not a word FTS can prefix-match), ⌘P
 * falls back to the SAME `fuzzyMatch`-over-`notes:listTitles` feed ⌘O uses,
 * so the result list is never empty when a title could match. This does NOT
 * regress content search: FTS still runs first and renders its snippet rows;
 * the fallback only fires when `results.length === 0`. The two doors stay
 * distinct (⌘P = content-first, ⌘O = title-first) — the fallback just keeps
 * ⌘P from showing "no matches." while a title subsequence exists.
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
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { ScrollArea } from '../components/ScrollArea'
import { api } from '../lib/api'
import { fuzzyMatch } from '../lib/fuzzy'
import { useSetting } from '../lib/use-setting'

// ── Highlight ─────────────────────────────────────────────────────────────────

/**
 * Render a title with `fuzzyMatch`-matched character indices wrapped in `<mark>`.
 * Consecutive matched/unmatched runs are coalesced into one node each so the DOM
 * stays compact. `matched` is sorted ascending (fuzzy.ts walks left-to-right).
 * Duplicated from QuickSwitcher.tsx by intent (no shared helper yet — locked
 * decision 4; a tiny private helper is the lower-risk choice).
 * Why: keeps this file's fallback highlight identical to ⌘O without coupling.
 */
function highlight(title: string, matched: number[]): React.ReactNode {
  if (matched.length === 0) return title
  const set = new Set(matched)
  const chars = [...title]
  const out: React.ReactNode[] = []
  let run = ''
  let runMatched = set.has(0)
  let key = 0
  const flush = () => {
    if (run === '') return
    out.push(
      runMatched ? (
        <mark key={key} style={{ background: 'var(--accent-tint)', color: 'inherit' }}>
          {run}
        </mark>
      ) : (
        <span key={key}>{run}</span>
      ),
    )
    key++
    run = ''
  }
  for (let i = 0; i < chars.length; i++) {
    const m = set.has(i)
    if (m !== runMatched) {
      flush()
      runMatched = m
    }
    run += chars[i]
  }
  flush()
  return out
}

interface Props {
  open: boolean
  onClose: () => void
  onJump: (noteId: string) => void
}

export function ContentSearch({ open, onClose, onJump }: Props) {
  const [query, setQuery] = useState('')
  // Tracks the currently highlighted Command.Item value (= note id). Controlled
  // so Tab/Shift+Tab can move selection directly without re-dispatching events.
  const [highlighted, setHighlighted] = useState('')
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
  // Uncapped title feed — the SAME `['note-titles']` cache key ⌘O uses, so
  // opening ⌘P after ⌘O (or vice-versa) hits the shared cache (no second
  // IPC round-trip). Powers the fuzzy-title fallback when FTS yields nothing.
  const { data: titles = [] } = useQuery({
    queryKey: ['note-titles'],
    queryFn: () => api.notes.listTitles(),
    enabled: open,
  })

  // Fuzzy-title fallback (⌘O-style): only when FTS returned nothing AND the
  // trimmed query is non-empty. `fuzzyMatch('  ')` returns ALL candidates
  // (fuzzy.ts:49 trims internally) — the trim gate prevents a whitespace
  // query from dumping every title via the fallback.
  const hasQuery = query.trim().length > 0
  const fuzzyResults = useMemo(
    () => (hasQuery && results.length === 0 ? fuzzyMatch(query, titles) : []),
    [hasQuery, query, results.length, titles],
  )
  // The ordered list of note ids currently rendered as rows (recents when
  // empty; FTS hits when typed; fuzzy fallback when FTS is empty). Drives
  // Tab/Shift+Tab direct-selection (no event re-dispatch).
  const rowIds = useMemo(
    () =>
      hasQuery
        ? results.length > 0
          ? results.map((h) => h.note.id)
          : fuzzyResults.map((r) => r.id)
        : recent.map((r) => r.id),
    [hasQuery, results, fuzzyResults, recent],
  )

  // Reset the query when the palette closes so the next open starts empty
  // (matches v21 palette UX; see command-palette.jsx).
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  function select(id: string) {
    onJump(id)
    onClose()
  }

  // Esc closes; Enter jumps to the highlighted row; Tab / Shift+Tab move
  // selection down / up the result list (item 9). See QuickSwitcher.handleKeyDown
  // for why we set `highlighted` directly instead of re-dispatching a synthesized
  // Arrow event (the re-dispatched event's target is the cmdk root DIV, not the
  // input, which leaks to document listeners like Feed's ArrowDown scroll handler).
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'Enter' && highlighted) {
      e.preventDefault()
      select(highlighted)
      return
    }
    if (e.key === 'Tab' && rowIds.length > 0) {
      e.preventDefault()
      const idx = rowIds.indexOf(highlighted)
      const next = e.shiftKey
        ? idx <= 0
          ? rowIds.length - 1
          : idx - 1
        : idx < 0 || idx >= rowIds.length - 1
          ? 0
          : idx + 1
      setHighlighted(rowIds[next]!)
    }
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      label="search"
      shouldFilter={false}
      value={highlighted}
      onValueChange={setHighlighted}
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
        onKeyDown={handleKeyDown}
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
          {query.length > 0 && results.length === 0 && fuzzyResults.length === 0 && (
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
          {/* Fuzzy-title fallback (⌘O-style): FTS found nothing, so surface
              subsequence title matches so the list is never empty when a
              title could match. Highlighted like ⌘O; no snippet (no body hit). */}
          {query.length > 0 &&
            results.length === 0 &&
            fuzzyResults.map((r) => (
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
                {highlight(r.title, r.matched)}
              </Command.Item>
            ))}
        </Command.List>
      </ScrollArea>
    </Command.Dialog>
  )
}
