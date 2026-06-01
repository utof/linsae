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

import { Camera, Send } from 'lucide-react'
import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { clampSeconds, formatClock, parseTimeDigits } from '../lib/time'
import { chipTime, nextFrozenAt } from './composer-chip'

/** Cap on auto-grown textarea height — mirrors the main Composer's ceiling. */
const TEXTAREA_MAX_HEIGHT_PX = 220

export interface ThreadComposerProps {
  /** Current playback time in seconds, live from usePlayer.currentTime. */
  livePlayhead: number
  /**
   * Total video length in seconds (null until the player reports it). Used to
   * clamp manual chip entry to the video's end and to pick the m:ss vs h:mm:ss
   * input hint. When null, no upper clamp is applied.
   */
  duration?: number | null
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
  duration = null,
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
    // FIX 4: allow an empty-caption post when a pending frame is present —
    // the screenshot IS the content. A truly empty post (no draft, no frame)
    // is still a no-op.
    if (!hasDraft && !pendingFrame) return
    // FIX 3: when a frame is pending the post MUST anchor to the capture
    // moment (pendingFrame.t), not the live chip time — they can differ.
    // Using the same value for both the chip display and onPost keeps them
    // consistent from the user's perspective.
    const t = pendingFrame
      ? pendingFrame.t
      : chipTime({ focused: effectiveFocused, hasDraft, livePlayhead, frozenAt })
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
  // chipInputValue holds RAW DIGITS only (no colon). It's parsed right-to-left
  // (parseTimeDigits) and clamped to the video duration on every keystroke for
  // the live display, and again on commit. Starting empty lets the user type a
  // fresh time; the placeholder shows the current anchor.
  const openChipInput = () => {
    setChipEditing(true)
    setChipInputValue('')
  }

  const commitChipInput = () => {
    if (chipInputValue !== '') {
      const secs = clampSeconds(parseTimeDigits(chipInputValue), duration)
      setFrozenAt(secs)
      setManuallyFrozen(true)
      onManualSeekEntry?.(secs)
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
  // FIX 3: when a pending frame is set, the chip must display the CAPTURE
  // moment (pendingFrame.t) so it matches what submit() will post. Without
  // this, the chip could show a different second than the posted anchor.
  const displaySeconds = pendingFrame
    ? pendingFrame.t
    : chipTime({ focused: effectiveFocused, hasDraft, livePlayhead, frozenAt })
  const displayTime = formatClock(displaySeconds)

  // Live preview of the digit entry: parsed right-to-left and clamped to the
  // video end. Empty while no digits are typed so the placeholder shows.
  const chipInputDisplay =
    chipInputValue === ''
      ? ''
      : formatClock(clampSeconds(parseTimeDigits(chipInputValue), duration))
  // m:ss for short videos, h:mm:ss once the video is an hour or longer.
  const chipInputHint = duration != null && duration >= 3600 ? 'h:mm:ss' : 'm:ss'

  // Shared style for the time pill + its edit input: deliberately matches the
  // textarea's font (sans, 13px, 1.5 line-height) so the highlighted timestamp
  // reads as part of the note text, just tinted — per the design call.
  const inlineTimeStyle: CSSProperties = {
    flexShrink: 0,
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    lineHeight: 1.5,
    padding: '0 6px',
    borderRadius: 'var(--r-1)',
    background: 'var(--accent-tint)',
    color: 'var(--accent-press)',
  }

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

      {/* Text row: leading inline time-pill + auto-grow textarea. The pill
          sits at the start of the first line at text size, so the anchor reads
          as part of the note (tinted, click to edit). */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        {chipEditing ? (
          <input
            data-testid="chip-time-input"
            type="text"
            inputMode="numeric"
            value={chipInputDisplay}
            // Digit-only: strip everything but 0-9 (the colon is auto-inserted by
            // formatClock for display) and cap at 6 digits → H:MM:SS.
            onChange={(e) => setChipInputValue(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={onChipInputKeyDown}
            onBlur={commitChipInput}
            // biome-ignore lint/a11y/noAutofocus: small inline input shown by user action
            autoFocus
            placeholder={chipInputHint}
            aria-label="edit chip time"
            style={{
              ...inlineTimeStyle,
              width: 68,
              border: '1px solid var(--accent)',
              outline: 'none',
            }}
          />
        ) : (
          <button
            type="button"
            data-testid="composer-chip"
            title="click to edit anchor time — type digits, e.g. 1234 → 12:34"
            aria-label="anchor time"
            onClick={openChipInput}
            style={{ ...inlineTimeStyle, border: 0, cursor: 'pointer' }}
          >
            {displayTime}
          </button>
        )}

        {/* Auto-grow textarea — starts at one line, grows as you type */}
        <textarea
          ref={textareaRef}
          rows={1}
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
            padding: 0,
          }}
        />
      </div>

      {/* Bottom toolbar (Telegram-style): capture on the left, bare send arrow
          on the right. No "note" label — the arrow is the affordance. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
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
            border: 0,
            background: 'transparent',
            color: 'var(--fg-2)',
            cursor: 'pointer',
          }}
        >
          <Camera size={16} />
        </button>

        <div style={{ flex: 1 }} />

        <button
          type="button"
          title="post note ↵"
          aria-label="post note"
          onClick={submit}
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: 'var(--r-pill)',
            border: 0,
            background: 'var(--accent)',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  )
}
