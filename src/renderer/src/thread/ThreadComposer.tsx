/**
 * ThreadComposer — the pinned composer at the bottom of the video annotation thread.
 *
 * Shows a frozen @chip anchoring the comment to a video second, an auto-grow
 * textarea (Enter submits, Shift+Enter newline), a Camera affordance for E4
 * frame capture, and a CornerDownLeft submit button.
 *
 * Freeze/resume logic is driven by the pure functions in composer-chip.ts:
 *   • `chipTime`     → displayed second.
 *   • `nextFrozenAt` → what to store; updated on focused/hasDraft transitions.
 *
 * The chip is FROZEN when the textarea is focused, has draft text, OR when the
 * user has manually set a time via the chip input (manuallyFrozen flag). It
 * LIVE-TRACKS the playhead when unfocused, empty, and not manually frozen.
 * Clicking the chip opens an inline mm:ss input for manual override.
 *
 * NO auto-pause on focus — spec §289.
 *
 * Visual source: v21-design-system/v21-youtube-view-handoff/ThreadView.jsx
 * Composer region (lines 221–234).
 *
 * @see src/renderer/src/thread/composer-chip.ts
 * @see src/renderer/src/composer/Composer.tsx (auto-grow + Enter-sends pattern)
 * @see docs/specs/v0.2-youtube-annotation.md §Composer
 */

import { Camera, CornerDownLeft } from 'lucide-react'
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { formatClock, parseClock } from '../lib/time'
import { chipTime, nextFrozenAt } from './composer-chip'

/** Cap on auto-grown textarea height — mirrors the main Composer's ceiling. */
const TEXTAREA_MAX_HEIGHT_PX = 220

export interface ThreadComposerProps {
  /** Current playback time in seconds, live from usePlayer.currentTime. */
  livePlayhead: number
  /**
   * A pending captured frame chip (⌘⇧C). E4 wires the actual capture;
   * when present a small thumbnail renders above the textarea.
   */
  pendingFrame?: { thumbnailUrl: string; t: number } | null
  /** Called on submit. ThreadView owns the api.notes.create + commentOn call. */
  onPost: (args: { body: string; t: number }) => void
  /**
   * Optional seek callback triggered when the user manually enters a time via
   * the chip input. Allows the player to jump to the chosen anchor.
   */
  onManualSeekEntry?: (seconds: number) => void
  /**
   * Optional capture callback — E4 wires ⌘⇧C frame capture here.
   * Present in the prop bag now so E4 can pass it without a signature change.
   */
  onCapture?: () => void
}

/** @see ThreadComposerProps */
export function ThreadComposer({
  livePlayhead,
  pendingFrame = null,
  onPost,
  onManualSeekEntry,
  onCapture,
}: ThreadComposerProps) {
  // ── local state ────────────────────────────────────────────────────────────
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const [frozenAt, setFrozenAt] = useState(livePlayhead)
  /**
   * True when the user has manually overridden the chip time via the inline
   * mm:ss input. Keeps the chip frozen in the live state (unfocused + empty)
   * until the next submit, at which point it resets to live-tracking.
   *
   * Why a separate flag: chipTime's pure interface (focused / hasDraft /
   * livePlayhead / frozenAt) does not have a "manual override" axis.
   * We model it as `focused=true` for display purposes via this flag.
   */
  const [manuallyFrozen, setManuallyFrozen] = useState(false)
  // Whether the chip manual-entry input is open.
  const [chipEditing, setChipEditing] = useState(false)
  const [chipInputValue, setChipInputValue] = useState('')

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ── derived ────────────────────────────────────────────────────────────────
  const hasDraft = draft.trim().length > 0
  // For chipTime / nextFrozenAt display: treat manuallyFrozen as "focused"
  // so the chip shows frozenAt rather than livePlayhead.
  const effectiveFocused = focused || manuallyFrozen

  // ── freeze/resume logic ───────────────────────────────────────────────────
  // Update frozenAt only when textarea focused, hasDraft, or manuallyFrozen
  // changes — NOT on every livePlayhead tick. Rationale:
  //   • When focused transitions true (textarea focus): capture livePlayhead.
  //   • When hasDraft transitions true (first keystroke): nextFrozenAt keeps prev.
  //   • When both go false (blur + cleared): returns livePlayhead so the NEXT
  //     focus captures a fresh value.
  //   • While focused, livePlayhead advances but we must NOT re-capture.
  //   • manuallyFrozen=true: early-return to prevent re-running nextFrozenAt and
  //     overwriting the user's explicit chip-input value (the original bug).
  //     When manuallyFrozen flips false (submit / blur-while-empty) the effect
  //     runs normally and resumes live capture.
  //   • In live state, chipTime returns livePlayhead directly — frozenAt doesn't
  //     need continuous updating.
  // biome-ignore lint/correctness/useExhaustiveDependencies: livePlayhead intentionally excluded — see comment
  useEffect(() => {
    // Short-circuit: a manual chip-input value must never be overwritten by a
    // focus-triggered re-capture. When manuallyFrozen flips back to false the
    // effect re-runs and resumes normal freeze/resume behaviour.
    // Why: bug fix — previously the effect ran on focus (focused→true) and called
    // nextFrozenAt(focused=true,hasDraft=false) → livePlayhead, silently
    // discarding the user's manually entered chip time.
    if (manuallyFrozen) return
    setFrozenAt((prev) => nextFrozenAt(prev, { focused, hasDraft, livePlayhead }))
  }, [focused, hasDraft, manuallyFrozen]) // livePlayhead deliberately excluded

  // ── auto-grow textarea ─────────────────────────────────────────────────────
  // Mirrors the pattern in src/renderer/src/composer/Composer.tsx.
  // useLayoutEffect runs before paint so the resize is never visible.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — see Composer.tsx
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`
  }, [draft])

  // ── submit ────────────────────────────────────────────────────────────────
  const submit = () => {
    if (!hasDraft) return
    const t = chipTime({ focused: effectiveFocused, hasDraft, livePlayhead, frozenAt })
    onPost({ body: draft, t })
    setDraft('')
    setManuallyFrozen(false)
    // Explicitly release the frozen state so chipTime resumes live-tracking
    // immediately on the next render with a new livePlayhead prop. This mirrors
    // the "clearing resumes live-tracking" contract from the spec — submitting
    // is a clearing event. The textarea may still hold DOM focus; we reset React
    // state so the freeze logic treats the composer as idle until the next focus.
    setFocused(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  // ── chip manual-entry ─────────────────────────────────────────────────────
  const openChipInput = () => {
    setChipEditing(true)
    setChipInputValue(
      formatClock(chipTime({ focused: effectiveFocused, hasDraft, livePlayhead, frozenAt })),
    )
  }

  const commitChipInput = () => {
    const parsed = parseClock(chipInputValue)
    if (parsed !== null) {
      setFrozenAt(parsed)
      setManuallyFrozen(true)
      onManualSeekEntry?.(parsed)
    }
    setChipEditing(false)
  }

  const dismissChipInput = () => {
    setChipEditing(false)
  }

  const onChipInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitChipInput()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      dismissChipInput()
    }
  }

  // ── displayed time ────────────────────────────────────────────────────────
  const displaySeconds = chipTime({ focused: effectiveFocused, hasDraft, livePlayhead, frozenAt })
  const displayTime = formatClock(displaySeconds)

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--border-1)',
        borderRadius: 'var(--r-4)',
        boxShadow: 'var(--shadow-2)',
        padding: '7px 9px',
      }}
    >
      {/* Pending frame thumbnail — E4 populates pendingFrame */}
      {pendingFrame != null && (
        <div style={{ marginBottom: 7 }}>
          <img
            src={pendingFrame.thumbnailUrl}
            alt="captured frame"
            aria-label="captured frame"
            style={{
              width: '100%',
              aspectRatio: '16 / 9',
              objectFit: 'cover',
              borderRadius: 'var(--r-3)',
              display: 'block',
            }}
          />
        </div>
      )}

      {/* Row: camera · chip · textarea · submit */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        {/* Camera button — E4 wires onCapture */}
        <button
          type="button"
          title="capture frame ⌘⇧C"
          aria-label="capture frame"
          onClick={onCapture}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            width: 28,
            height: 28,
            borderRadius: 'var(--r-2)',
            border: '1px solid var(--border-0)',
            background: 'var(--bg-1)',
            color: 'var(--fg-2)',
            cursor: 'pointer',
          }}
        >
          <Camera size={15} />
        </button>

        {/* Time chip — frozen or live; click opens manual entry */}
        {chipEditing ? (
          <input
            data-testid="chip-time-input"
            type="text"
            value={chipInputValue}
            onChange={(e) => setChipInputValue(e.target.value)}
            onKeyDown={onChipInputKeyDown}
            onBlur={commitChipInput}
            // biome-ignore lint/a11y/noAutofocus: small inline input shown by user action
            autoFocus
            placeholder="m:ss"
            aria-label="edit chip time"
            style={{
              flexShrink: 0,
              width: 52,
              height: 18,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--accent-press)',
              background: 'var(--accent-tint)',
              border: '1px solid var(--accent)',
              borderRadius: 'var(--r-1)',
              padding: '0 5px',
              outline: 'none',
            }}
          />
        ) : (
          <button
            type="button"
            data-testid="composer-chip"
            title="click to edit anchor time"
            aria-label="anchor time"
            onClick={openChipInput}
            style={{
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              height: 18,
              padding: '0 6px',
              borderRadius: 'var(--r-1)',
              background: 'var(--accent-tint)',
              color: 'var(--accent-press)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              border: 0,
              cursor: 'pointer',
            }}
          >
            {displayTime}
          </button>
        )}

        {/* Auto-grow textarea */}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            // Clear manual freeze when the user abandons the composer without
            // posting. Without this the chip would stay frozen at the manually
            // entered time indefinitely even after the user walks away.
            // Why: "blur-while-empty = abandon = resume live-tracking" contract.
            if (!hasDraft) setManuallyFrozen(false)
          }}
          onKeyDown={onKeyDown}
          aria-label="write a note"
          placeholder="note at this frame…"
          style={{
            flex: 1,
            border: 0,
            outline: 'none',
            resize: 'none',
            overflowY: 'auto',
            fontFamily: 'var(--font-sans)',
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--fg-0)',
            background: 'transparent',
          }}
        />

        {/* Submit button */}
        <button
          type="button"
          title="post note ↵"
          aria-label="post note"
          onClick={submit}
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 28,
            padding: '0 12px',
            borderRadius: 'var(--r-2)',
            border: 0,
            background: 'var(--accent)',
            color: '#fff',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          note <CornerDownLeft size={13} />
        </button>
      </div>
    </div>
  )
}
