/**
 * ⌘O quick-switcher — fuzzy search by TITLE over the uncapped notes:listTitles
 * feed, jump to the note. Empty query → recent/frecent (notes:recent, mode from
 * the notes.recencyMode setting). Mirrors the canvas Picker.tsx shape
 * (shouldFilter={false} + fuzzyMatch + <mark> highlight + trim gate) but as a
 * centered modal Command.Dialog. Titles only in v0.5 (alias matching = #129).
 *
 * Why `shouldFilter={false}`: `fuzzyMatch` already filters + ranks (and yields the
 * `matched` indices for `<mark>` highlighting); cmdk's built-in filter would
 * re-order our results (same rationale as Picker.tsx / ContentSearch.tsx).
 *
 * Why gate rows on `query.trim().length > 0`: `fuzzyMatch('  ')` returns ALL
 * candidates (fuzzy.ts:49 trims), so without the trim gate a whitespace query
 * would dump every title; the empty-query path shows recent/frecent instead.
 *
 * @see docs/specs/v0.5-command-search.md §5
 * @see src/renderer/src/canvas/Picker.tsx (sibling — same fuzzy+highlight pipe)
 */
import { useQuery } from '@tanstack/react-query'
import { Command } from 'cmdk'
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { fuzzyMatch } from '../lib/fuzzy'
import { useSetting } from '../lib/use-setting'

// ── Highlight ─────────────────────────────────────────────────────────────────

/**
 * Render a title with `fuzzyMatch`-matched character indices wrapped in `<mark>`.
 * Consecutive matched/unmatched runs are coalesced into one node each so the DOM
 * stays compact. `matched` is sorted ascending (fuzzy.ts walks left-to-right).
 * Duplicated from Picker.tsx by intent (no shared `PickerBase` yet — locked
 * decision 4; a tiny private helper is the lower-risk choice).
 * Why: keeps this file's highlight identical to its sibling without coupling them.
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

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean
  onJump: (noteId: string) => void
  onClose: () => void
}

// ── Component ─────────────────────────────────────────────────────────────────

export function QuickSwitcher({ open, onJump, onClose }: Props) {
  const [query, setQuery] = useState('')
  // Tracks the currently highlighted Command.Item value (= note id).
  const [highlighted, setHighlighted] = useState('')
  const mode = useSetting<'recent' | 'frecent'>('notes.recencyMode', 'frecent')

  // Uncapped title feed (#130 cap fix); fetched lazily on open.
  const { data: titles = [] } = useQuery({
    queryKey: ['note-titles'],
    queryFn: () => api.notes.listTitles(),
    enabled: open,
  })
  // Empty-query recents — ordered by the recencyMode setting (recent | frecent).
  const { data: recent = [] } = useQuery({
    queryKey: ['note-recent', mode],
    queryFn: () => api.notes.recent(mode, 15),
    enabled: open,
  })

  // Gate on TRIMMED length to agree with fuzzyMatch (fuzzy.ts:49 trims): a
  // whitespace-only query has length>0 but fuzzyMatch returns ALL candidates,
  // so a raw length gate would dump every title; the recent feed shows instead.
  const hasQuery = query.trim().length > 0
  const results = useMemo(
    () => (hasQuery ? fuzzyMatch(query, titles) : []),
    [hasQuery, query, titles],
  )
  // NoteTitleRow ({id,title}) IS fuzzyMatch's candidate shape — no remap needed.
  const rows = hasQuery ? results : recent.map((r) => ({ ...r, matched: [] as number[] }))

  // Reset the query when the switcher closes so the next open starts empty
  // (matches ContentSearch.tsx / v21 palette UX).
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  function select(id: string) {
    onJump(id)
    onClose()
  }

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
    // Tab / Shift+Tab move selection down / up the result list (item 9). cmdk
    // owns ArrowUp/ArrowDown internally (its root onKeyDown); Tab is NOT in that
    // map. Why NOT re-dispatch a synthesized Arrow event on the cmdk root (the
    // previous approach): a re-dispatched KeyboardEvent has target = the root
    // DIV (not the <input>), so document-level listeners that guard on
    // isTypingTarget (e.g. Feed's ArrowDown scroll handler) see a non-typing
    // target and run — scrolling the feed instead of the palette. Instead we
    // compute the next/prev row id directly from the `rows` array and set the
    // controlled `highlighted` value (cmdk's `value` prop), which moves the
    // selection with NO event leak. preventDefault stops Tab's native focus move.
    if (e.key === 'Tab' && rows.length > 0) {
      e.preventDefault()
      const idx = rows.findIndex((r) => r.id === highlighted)
      const next = e.shiftKey
        ? idx <= 0
          ? rows.length - 1
          : idx - 1
        : idx < 0 || idx >= rows.length - 1
          ? 0
          : idx + 1
      setHighlighted(rows[next]!.id)
    }
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      label="search by title"
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
        placeholder="jump to a note by title…"
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
        {rows.length === 0 && (
          <Command.Empty style={{ padding: 12, color: 'var(--fg-3)', fontSize: 12 }}>
            {hasQuery ? 'no matches.' : 'no recent notes.'}
          </Command.Empty>
        )}
        {rows.map((r) => (
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
            {hasQuery ? highlight(r.title, r.matched) : r.title}
          </Command.Item>
        ))}
      </Command.List>
    </Command.Dialog>
  )
}
