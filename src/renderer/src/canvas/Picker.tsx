/**
 * Canvas `/` picker — a small `cmdk` Command surface anchored at a viewport
 * screen point. Ranks the live `notes:list` (cached `['notes']`) in-memory via
 * `fuzzyMatch` (subsequence + fzf-style scoring, spec §4 / decision 5); the
 * candidate set is small (data layer caps `notes:list` at 500), so a subsequence
 * scan is exact + instant — no server round-trip. Feed/global search keeps FTS
 * (#130). Does NOT use `Command.Dialog` — no modal backdrop; the component
 * floats at the cursor via `position:absolute`.
 *
 * Responsibilities (this component only):
 *   - Candidate list: `notes:list` → `{id, title: noteTitle(n)}`, ranked by
 *     `fuzzyMatch`; an id→note map resolves each row's type glyph.
 *   - Row rendering: type glyph + fuzzy-highlighted `<mark>` title + ▦ chip when placed.
 *   - Keymap: `↵` pick highlighted (keepOpen:false), `⇧↵` pick (keepOpen:true),
 *     `esc` close + stopPropagation (prevents double-fire on canvas esc cascade).
 *   - ▦ row selection → `onJump` (jump-not-duplicate, spec §5).
 *
 * Positioning to world coords and cascade-offset for `⇧↵` are CanvasStage's
 * concern (Task 8) — this component only takes a screen-pixel `anchor`.
 *
 * Why `shouldFilter={false}`: `fuzzyMatch` already filters + ranks (and gives us
 * `matched` indices for `<mark>` highlighting); cmdk's own filter would re-order
 * our results (same rationale as EdgeTargetPicker.tsx).
 *
 * Why gate rows on a non-blank query (`query.trim().length > 0`, mirroring
 * `fuzzyMatch`'s own trim): `fuzzyMatch('')`/`fuzzyMatch('  ')` return ALL
 * candidates, so without the gate an empty-or-whitespace `/` would dump every
 * note; the empty-query hint stands alone instead (and ⇧↵'s clear-query
 * keep-open path stays clean).
 *
 * Why controlled `Command value`/`onValueChange`: cmdk tracks the highlighted
 * item via the `value` prop when `shouldFilter={false}`; reading it in the
 * Enter handler gives us the currently-highlighted id without DOM querying.
 *
 * @see docs/specs/v0.4.1-canvas-edges.md §4 (decision 5 — rewire / picker to fuzzy.ts)
 * @see docs/plans/v0.4.1-canvas-edges.md Task 8
 * @see src/renderer/src/canvas/EdgeTargetPicker.tsx (sibling — same notes:list + fuzzy + highlight pipe)
 */

import { useQuery } from '@tanstack/react-query'
import { Command } from 'cmdk'
import type React from 'react'
import { useMemo, useState } from 'react'
import type { NoteType } from '../../../shared/types'
import { api } from '../lib/api'
import { fuzzyMatch } from '../lib/fuzzy'
import { noteTitle } from '../lib/note-title'
import { NOTE_TYPE_COLOR, NOTE_TYPE_GLYPH } from '../lib/note-type-glyph'

// ── Highlight ─────────────────────────────────────────────────────────────────

/**
 * Render a title with `fuzzyMatch`-matched character indices wrapped in `<mark>`.
 * Consecutive matched/unmatched runs are coalesced into one node each so the DOM
 * stays compact. `matched` is sorted ascending (fuzzy.ts walks left-to-right).
 * Duplicated from EdgeTargetPicker.tsx by intent (no shared `PickerBase` yet —
 * locked decision 4; a tiny private helper is the lower-risk choice).
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

export interface PickerProps {
  /** Viewport-relative screen point where the picker is anchored (cursor at `/` time). */
  anchor: { x: number; y: number }
  /** Set of note ids currently placed on the canvas. */
  placedNoteIds: ReadonlySet<string>
  /**
   * Called when the user selects an unplaced row.
   * `keepOpen:true` → Shift+Enter (cascade seeding); CanvasStage offsets subsequent drops.
   */
  onPick: (noteId: string, opts: { keepOpen: boolean }) => void
  /**
   * Called when the user selects a ▦ (already-placed) row.
   * Jump-not-duplicate: the note is already on the canvas, so we pan to it.
   */
  onJump: (noteId: string) => void
  /** Dismiss the picker (Escape or blur). */
  onClose: () => void
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Canvas `/` picker component.
 * @see PickerProps
 */
export function Picker({ anchor, placedNoteIds, onPick, onJump, onClose }: PickerProps) {
  const [query, setQuery] = useState('')
  // Tracks the currently highlighted Command.Item value (= note id).
  const [highlighted, setHighlighted] = useState('')

  // Candidate list = all live notes. The data layer caps `notes:list` at 500;
  // react-query cached on ['notes'] — the same key CanvasStage's create/save
  // mutations invalidate (mirrors EdgeTargetPicker).
  const { data: notes = [] } = useQuery({ queryKey: ['notes'], queryFn: () => api.notes.list() })
  const candidates = useMemo(() => notes.map((n) => ({ id: n.id, title: noteTitle(n) })), [notes])
  // id→note map resolves each fuzzy row back to its full note for the type glyph.
  const noteById = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes])
  const results = useMemo(() => fuzzyMatch(query, candidates), [query, candidates])
  // Gate rows/hint on TRIMMED length to agree with fuzzyMatch (fuzzy.ts:49 trims):
  // a whitespace-only query (`" "`) has length>0 but fuzzyMatch returns ALL
  // candidates, so a raw `query.length` gate would dump every note + hide the
  // hint. `hasQuery` keeps the hint up until there's a non-blank query.
  const hasQuery = query.trim().length > 0

  // cmdk auto-highlights the first rendered item and emits its value through
  // `onValueChange` (and again on arrow-key navigation), so `highlighted` always
  // mirrors the current cmdk selection. The Enter handler reads it directly.

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation() // §15: prevent canvas esc cascade double-fire
      onClose()
      return
    }
    if (e.key === 'Enter' && highlighted) {
      e.preventDefault()
      if (placedNoteIds.has(highlighted)) {
        onJump(highlighted)
      } else {
        const keepOpen = e.shiftKey
        onPick(highlighted, { keepOpen })
        // ⇧↵ seeds a board: keep the picker open but reset the query so the user
        // picks a DIFFERENT note next, not the same highlighted row again (spec
        // §5 / plan Task 5). The +24,+24 cascade offset is CanvasStage's concern.
        if (keepOpen) setQuery('')
      }
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: anchor.x,
        top: anchor.y,
        zIndex: 200,
        width: 340,
        background: 'var(--bg-0)',
        border: '1px solid var(--border-1)',
        borderRadius: 'var(--r-4)',
        boxShadow: 'var(--shadow-3)',
        fontFamily: 'var(--font-sans)',
        overflow: 'hidden',
      }}
    >
      <Command
        shouldFilter={false}
        value={highlighted}
        onValueChange={setHighlighted}
        label="place a note"
      >
        <Command.Input
          value={query}
          onValueChange={setQuery}
          onKeyDown={handleKeyDown}
          placeholder="search to place…"
          style={{
            width: '100%',
            border: 0,
            outline: 'none',
            padding: '10px 14px',
            fontSize: 13,
            fontFamily: 'var(--font-sans)',
            borderBottom: '1px solid var(--border-0)',
            boxSizing: 'border-box',
          }}
        />
        <Command.List
          style={{
            maxHeight: 280,
            overflowY: 'auto',
            padding: 4,
          }}
        >
          {!hasQuery && (
            <Command.Empty style={{ padding: '8px 12px', color: 'var(--fg-3)', fontSize: 12 }}>
              type to search…
            </Command.Empty>
          )}
          {hasQuery && results.length === 0 && (
            <Command.Empty style={{ padding: '8px 12px', color: 'var(--fg-3)', fontSize: 12 }}>
              no matches.
            </Command.Empty>
          )}
          {hasQuery &&
            results.map((hit) => {
              const placed = placedNoteIds.has(hit.id)
              const type = noteById.get(hit.id)?.type as NoteType | undefined
              return (
                <Command.Item
                  key={hit.id}
                  value={hit.id}
                  onSelect={() => {
                    if (placed) {
                      onJump(hit.id)
                    } else {
                      onPick(hit.id, { keepOpen: false })
                    }
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '7px 10px',
                    borderRadius: 'var(--r-3)',
                    fontSize: 13,
                    color: 'var(--fg-1)',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  {/* Type glyph (resolved from the full note via id→note map) */}
                  <span
                    aria-hidden="true"
                    style={{
                      fontSize: 10,
                      color: (type && NOTE_TYPE_COLOR[type]) ?? 'var(--fg-3)',
                      flexShrink: 0,
                      width: 12,
                      textAlign: 'center',
                    }}
                  >
                    {(type && NOTE_TYPE_GLYPH[type]) ?? '●'}
                  </span>
                  {/* Title with fuzzy-matched chars highlighted */}
                  <span
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {highlight(hit.title, hit.matched)}
                  </span>
                  {/* ▦ chip: indicates the note is already placed on the canvas */}
                  {placed && (
                    <span
                      style={{
                        fontSize: 10,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--fg-3)',
                        border: '1px solid var(--border-0)',
                        borderRadius: 'var(--r-2)',
                        padding: '1px 4px',
                        flexShrink: 0,
                      }}
                    >
                      ▦
                    </span>
                  )}
                </Command.Item>
              )
            })}
        </Command.List>
        {/* Footer hint — verbatim per spec §5 */}
        <div
          style={{
            padding: '6px 14px',
            fontSize: 11,
            color: 'var(--fg-3)',
            borderTop: '1px solid var(--border-0)',
            fontFamily: 'var(--font-mono)',
            userSelect: 'none',
          }}
        >
          ↵ place here · ⇧↵ place + keep picker · esc
        </div>
      </Command>
    </div>
  )
}
