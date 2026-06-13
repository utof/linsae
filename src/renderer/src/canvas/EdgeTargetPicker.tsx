/**
 * Canvas edge-target picker (spec §4) — the cmdk surface that opens when an
 * edge is dropped into EMPTY space. Fuzzy-searches live notes by title; a row
 * either CONNECTS to an already-placed note (▦) or PLACES an unplaced note at
 * the drop point and connects; a trailing "create" row makes a new note there
 * and connects. Either way both endpoints end up placed so the edge renders
 * (§11). A sibling of `Picker.tsx` (NOT a shared base — locked decision 4).
 *
 * Responsibilities (this component only):
 *   - Candidate list: `notes:list` → `{id, title: noteTitle(n)}` (the §4
 *     candidate shape), ranked in-memory via `fuzzyMatch` (§4 subsequence).
 *   - Row rendering: title with `matched` chars wrapped in `<mark>`, plus a ▦
 *     chip when the id is already placed; a "Create <query>" row when non-empty.
 *   - Keymap: `↵` route the highlighted row, `esc` close + stopPropagation
 *     (prevents the canvas esc cascade from double-firing — same as Picker).
 *
 * Routing (CanvasStage wires the effects): an existing row → `onConnectExisting`
 * when placed else `onPlaceAndConnect`; the create row → `onCreateAndConnect`.
 *
 * Why `shouldFilter={false}`: `fuzzyMatch` already filters+ranks; cmdk's own
 * filter would re-order our results (same rationale as Picker.tsx).
 *
 * Why controlled `Command value`/`onValueChange`: with `shouldFilter={false}`
 * cmdk tracks the highlighted item through `value`; the Enter handler reads it
 * to route without DOM querying. The reserved `__create__` value marks the
 * create row so Enter on it can't collide with a real note id.
 *
 * @see docs/specs/v0.4.1-canvas-edges.md §4
 * @see docs/plans/v0.4.1-canvas-edges.md Task 7
 * @see src/renderer/src/canvas/Picker.tsx (mirrored structure)
 */

import { useQuery } from '@tanstack/react-query'
import { Command } from 'cmdk'
import type React from 'react'
import { useMemo, useState } from 'react'
import { api } from '../lib/api'
import { fuzzyMatch } from '../lib/fuzzy'
import { noteTitle } from '../lib/note-title'

/** Sentinel `Command.Item` value for the trailing "create" row. */
const CREATE_VALUE = '__create__'

// ── Props ─────────────────────────────────────────────────────────────────────

export interface EdgeTargetPickerProps {
  /** Viewport-relative screen point where the picker is anchored (the drop point). */
  anchor: { x: number; y: number }
  /** Set of note ids currently placed on the canvas. */
  placedNoteIds: ReadonlySet<string>
  /** Selected an already-placed (▦) row → just connect, no re-place. */
  onConnectExisting: (noteId: string) => void
  /** Selected an existing UNPLACED row → place it at the drop point, then connect. */
  onPlaceAndConnect: (noteId: string) => void
  /** Selected the "create" row → make a note from `body` at the drop point, then connect. */
  onCreateAndConnect: (body: string) => void
  /** Dismiss the picker (Escape). */
  onClose: () => void
}

// ── Highlight ─────────────────────────────────────────────────────────────────

/**
 * Render a title with `fuzzyMatch`-matched character indices wrapped in `<mark>`.
 * Consecutive matched/unmatched runs are coalesced into one node each (one
 * `<mark>` per matched run) so the DOM stays compact and a run's text is one
 * text node. `matched` is sorted ascending (fuzzy.ts walks left-to-right).
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

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Canvas edge-target picker component.
 * @see EdgeTargetPickerProps
 */
export function EdgeTargetPicker({
  anchor,
  placedNoteIds,
  onConnectExisting,
  onPlaceAndConnect,
  onCreateAndConnect,
  onClose,
}: EdgeTargetPickerProps) {
  const [query, setQuery] = useState('')
  // Tracks the currently highlighted Command.Item value (= note id or CREATE_VALUE).
  const [highlighted, setHighlighted] = useState('')

  // Candidate list = all live notes. The data layer caps `notes:list` at 500
  // (§2), not this component. React-query cached on ['notes'] — the same key
  // CanvasStage's create/save mutations invalidate.
  const { data: notes = [] } = useQuery({ queryKey: ['notes'], queryFn: () => api.notes.list() })
  const candidates = useMemo(() => notes.map((n) => ({ id: n.id, title: noteTitle(n) })), [notes])
  const results = useMemo(() => fuzzyMatch(query, candidates), [query, candidates])

  const trimmed = query.trim()
  const showCreate = trimmed.length > 0

  /** Route an existing row: placed → connect, unplaced → place-then-connect. */
  function pickNote(id: string) {
    if (placedNoteIds.has(id)) onConnectExisting(id)
    else onPlaceAndConnect(id)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation() // prevent canvas esc cascade double-fire (mirrors Picker)
      onClose()
      return
    }
    if (e.key === 'Enter' && highlighted) {
      e.preventDefault()
      if (highlighted === CREATE_VALUE) onCreateAndConnect(query)
      else pickNote(highlighted)
    }
  }

  return (
    <div
      data-edge-target-picker
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
        label="connect to a note"
      >
        <Command.Input
          value={query}
          onValueChange={setQuery}
          onKeyDown={handleKeyDown}
          placeholder="connect to…"
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
          {results.map((hit) => {
            const placed = placedNoteIds.has(hit.id)
            return (
              <Command.Item
                key={hit.id}
                value={hit.id}
                onSelect={() => pickNote(hit.id)}
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
                {/* ▦ chip: the note is already placed → selecting it just connects. */}
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
          {/* Create affordance — only when the query is non-empty. */}
          {showCreate && (
            <Command.Item
              value={CREATE_VALUE}
              onSelect={() => onCreateAndConnect(query)}
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
              <span
                style={{
                  fontSize: 10,
                  color: 'var(--accent)',
                  flexShrink: 0,
                  width: 12,
                  textAlign: 'center',
                }}
                aria-hidden="true"
              >
                +
              </span>
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {`Create "${trimmed}"`}
              </span>
            </Command.Item>
          )}
        </Command.List>
        {/* Footer hint */}
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
          ↵ connect · esc
        </div>
      </Command>
    </div>
  )
}
