/**
 * ⌘K command palette — lists the dynamically-registered commands
 * (useCommandStore), fuzzy-filtered by label via fuzzy.ts (consistent with the
 * other doors), each row showing its hotkey hint. Filters by each command's
 * when() gate. Enter runs command.run() + closes. The base set + contextual
 * commands are registered by App/contexts (Task 12).
 *
 * Why subscribe to `registry` (the Map) + derive in useMemo, NOT
 * `useCommandStore((s) => s.commands())`: `commands()` builds a FRESH array
 * each call, so that selector fails zustand v5's Object.is snapshot equality on
 * every store update → unconditional re-renders + a getSnapshot caching warning.
 * Subscribing to the stable `registry` reference and deriving the array in
 * useMemo keeps the selector identity-stable.
 *
 * Why `shouldFilter={false}`: `fuzzyMatch` already filters + ranks (and yields
 * the `matched` indices for `<mark>` highlighting); cmdk's own filter would
 * re-order our results (same rationale as QuickSwitcher.tsx / Picker.tsx).
 *
 * Empty query → `fuzzyMatch('')` returns ALL candidates in registry order
 * (fuzzy.ts:49), so an empty ⌘K shows every registered command — the intended
 * "run a command" launcher behavior.
 *
 * @see docs/specs/v0.5-command-search.md §4
 * @see src/renderer/src/palette/QuickSwitcher.tsx (sibling — same modal + fuzzy + highlight pipe)
 */
import { Command } from 'cmdk'
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { fuzzyMatch } from '../lib/fuzzy'
import { useCommandStore } from './command-store'

// ── Highlight ─────────────────────────────────────────────────────────────────

/**
 * Render a label with `fuzzyMatch`-matched character indices wrapped in `<mark>`.
 * Consecutive matched/unmatched runs are coalesced into one node each so the DOM
 * stays compact. `matched` is sorted ascending (fuzzy.ts walks left-to-right).
 * Duplicated from QuickSwitcher.tsx / Picker.tsx by intent (no shared
 * `PickerBase` yet — locked decision 4; a tiny private helper is the lower-risk
 * choice).
 * Why: keeps this file's highlight identical to its siblings without coupling them.
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
  onClose: () => void
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CommandMenu({ open, onClose }: Props) {
  const [query, setQuery] = useState('')
  // Tracks the currently highlighted Command.Item value (= command id).
  const [highlighted, setHighlighted] = useState('')
  // Subscribe to the stable Map reference; derive the array in useMemo (see file doc).
  const registry = useCommandStore((s) => s.registry)

  const visible = useMemo(
    () => [...registry.values()].filter((c) => c.when?.() ?? true),
    [registry],
  )
  const byId = useMemo(() => new Map(visible.map((c) => [c.id, c])), [visible])
  // fuzzyMatch keys on `title`, so map each command's label onto `title`.
  const candidates = useMemo(() => visible.map((c) => ({ id: c.id, title: c.label })), [visible])
  // Empty query → all candidates in registry order (fuzzy.ts:49).
  const results = useMemo(() => fuzzyMatch(query, candidates), [query, candidates])

  // Reset the query when the menu closes so the next open starts empty
  // (matches QuickSwitcher.tsx / ContentSearch.tsx UX).
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  function runById(id: string) {
    void byId.get(id)?.run()
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
      runById(highlighted)
    }
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      label="commands"
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
        placeholder="run a command…"
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
        {results.length === 0 && (
          <Command.Empty style={{ padding: 12, color: 'var(--fg-3)', fontSize: 12 }}>
            no commands.
          </Command.Empty>
        )}
        {results.map((r) => {
          const c = byId.get(r.id)
          return (
            <Command.Item
              key={r.id}
              value={r.id}
              onSelect={() => runById(r.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                borderRadius: 6,
                fontSize: 13,
                color: 'var(--fg-1)',
                cursor: 'pointer',
              }}
            >
              <span>{highlight(r.title, r.matched)}</span>
              {c?.hint && (
                <span
                  style={{ color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                >
                  {c.hint}
                </span>
              )}
            </Command.Item>
          )
        })}
      </Command.List>
    </Command.Dialog>
  )
}
