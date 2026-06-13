/**
 * Canvas `/` picker — a small `cmdk` Command surface anchored at a viewport
 * screen point. Reuses FTS search (`api.search.run`) keyed `['search', query]`
 * (same engine as CommandPalette). Does NOT use `Command.Dialog` — no modal
 * backdrop; the component floats at the cursor via `position:absolute`.
 *
 * Responsibilities (this component only):
 *   - Query state + FTS fetch.
 *   - Row rendering: type glyph + `noteTitle` + ▦ chip when placed.
 *   - Keymap: `↵` pick highlighted (keepOpen:false), `⇧↵` pick (keepOpen:true),
 *     `esc` close + stopPropagation (prevents double-fire on canvas esc cascade).
 *   - ▦ row selection → `onJump` (jump-not-duplicate, spec §5).
 *
 * Positioning to world coords and cascade-offset for `⇧↵` are CanvasStage's
 * concern (Task 8) — this component only takes a screen-pixel `anchor`.
 *
 * Why `shouldFilter={false}`: FTS5 ranks results server-side via `bm25()` and
 * returns `snippet()`-highlighted excerpts; cmdk re-filtering would discard that
 * ranking (same rationale as CommandPalette — see its TSDoc).
 *
 * Why controlled `Command value`/`onValueChange`: cmdk tracks the highlighted
 * item via the `value` prop when `shouldFilter={false}`; reading it in the
 * Enter handler gives us the currently-highlighted id without DOM querying.
 *
 * @see docs/specs/v0.4-canvas-mvp.md §5
 * @see docs/plans/v0.4-canvas-mvp-3-placement-chrome.md Task 5
 * @see src/renderer/src/palette/CommandPalette.tsx (shouldFilter pattern)
 */

import { useQuery } from '@tanstack/react-query'
import { Command } from 'cmdk'
import type React from 'react'
import { useState } from 'react'
import type { NoteType } from '../../../shared/types'
import { api } from '../lib/api'
import { noteTitle } from '../lib/note-title'
import { NOTE_TYPE_COLOR, NOTE_TYPE_GLYPH } from '../lib/note-type-glyph'

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

  const { data: results = [] } = useQuery({
    queryKey: ['search', query],
    queryFn: () => api.search.run(query),
    enabled: query.length > 0,
  })

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
        onPick(highlighted, { keepOpen: e.shiftKey })
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
          {query.length === 0 && (
            <Command.Empty style={{ padding: '8px 12px', color: 'var(--fg-3)', fontSize: 12 }}>
              type to search…
            </Command.Empty>
          )}
          {query.length > 0 && results.length === 0 && (
            <Command.Empty style={{ padding: '8px 12px', color: 'var(--fg-3)', fontSize: 12 }}>
              no matches.
            </Command.Empty>
          )}
          {query.length > 0 &&
            results.map((hit) => {
              const placed = placedNoteIds.has(hit.note.id)
              const type = hit.note.type as NoteType
              return (
                <Command.Item
                  key={hit.note.id}
                  value={hit.note.id}
                  onSelect={() => {
                    if (placed) {
                      onJump(hit.note.id)
                    } else {
                      onPick(hit.note.id, { keepOpen: false })
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
                  {/* Type glyph */}
                  <span
                    aria-hidden="true"
                    style={{
                      fontSize: 10,
                      color: NOTE_TYPE_COLOR[type] ?? 'var(--fg-3)',
                      flexShrink: 0,
                      width: 12,
                      textAlign: 'center',
                    }}
                  >
                    {NOTE_TYPE_GLYPH[type] ?? '●'}
                  </span>
                  {/* Title */}
                  <span
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {noteTitle(hit.note)}
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
