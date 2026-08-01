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
 * **Clear-on-success contract.** This composer NEVER clears its own state
 * optimistically: `submit()` awaits `onPost` and defers all five post-submit
 * updates (draft, `onDraftClear`, `manuallyFrozen`, `anchorless`, `focused`) to
 * the resolve branch. On rejection nothing is cleared, so the user's text — on
 * screen and in the durable `composer.draft.thread.v1` entry — survives a
 * failed post, and the anchor survives with it. `notes.create` is a real throw
 * site: two short identical replies collide on the body-derived slug and
 * `save-note.ts:164` rejects.
 *
 * Visual source: v21-design-system/v21-youtube-view-handoff/ThreadView.jsx
 * Composer region (lines 221–234).
 *
 * @issue utof/linsae#176
 * @see docs/plans/v0.8.2-composer-dataloss.md §2.2 (the contract)
 * @see src/renderer/src/thread/SimpleComposer.tsx (the same contract, plain threads)
 * @see src/renderer/src/thread/composer-chip.ts
 * @see src/renderer/src/composer/Composer.tsx (auto-grow + Enter-sends pattern)
 * @see docs/specs/v0.2-youtube-annotation.md §Composer
 */

import { Camera } from 'lucide-react'
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { Attachment } from '../../../shared/types'
import { AnnotatedFrame } from '../annotate/AnnotatedFrame'
import { SendButton } from '../composer/SendButton'
import { useAutoGrowTextarea } from '../composer/useAutoGrowTextarea'
import { clampSeconds, formatClock, parseTimeDigits } from '../lib/time'
import { chipTime, nextFrozenAt } from './composer-chip'

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
   * A pending captured frame chip (⌘⇧C). When present, the captured frame
   * renders above the textarea via `AnnotatedFrame` — so a frame annotated in
   * the capture-time editor shows its overlay in the chip (v0.2.5 contract
   * change; was `{ thumbnailUrl; t }` rendering the bare base PNG). `t` is the
   * captured moment (drives the chip timestamp + the posted anchor).
   * @see docs/specs/v0.2.5-screenshot-annotation.md §Capture-time
   */
  pendingFrame?: { attachment: Attachment; t: number } | null
  /**
   * Called on submit. ThreadView owns the api.notes.create + commentOn call.
   *
   * May be async: `submit()` awaits it and treats a REJECTION as "nothing was
   * posted" — the draft and every piece of freeze state are left exactly as
   * they were. A resolving `onPost` therefore means "the note exists"; a parent
   * that swallows its own failure re-introduces #176 one layer up. TanStack
   * Query's `mutate` is exactly that trap — it returns `void` and never
   * rejects, so ThreadView must call `mutateAsync`.
   *
   * `t: null` = ANCHORLESS (untimestamped) — the note is posted without a `t`
   * on its youtube locator. Happens when a RESTORED draft is posted without the
   * user adding a manual time (v0.7: only draft text is persisted, never the
   * chip's frozenAt, so the original timestamp is unrecoverable). A numeric `t`
   * is the anchored second (live/frozen chip time, manual entry, or frame).
   * @see docs/plans/v0.7-session-persistence.md §Task 4.2
   */
  onPost: (args: { body: string; t: number | null }) => void | Promise<void>
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
  /**
   * User-facing error from the last post attempt (e.g. duplicate-slug). When
   * set, the card border turns red and the message renders below. The draft IS
   * preserved so the user can edit + retry — enforced by the clear-on-success
   * contract in `submit()`, not merely intended: before v0.8.2 this sentence
   * was false, which is what #176 reported. Mirrors the feed Composer's UX.
   *
   * PARENT-OWNED, deliberately: ThreadView holds `postError` and a second,
   * composer-local copy is two owners that can disagree — which is how this bug
   * class recurs.
   */
  error?: string | null
  /** Called on the next keystroke when `error` is set, so the parent clears it. */
  onClearError?: () => void
  /**
   * Restored draft text for THIS thread's root, applied ONCE as the initial
   * `draft` (v0.7 Task 4.2). App sources it from `snap.data.draftThread[rootId]`.
   * ONLY the draft text is persisted — never the chip / frozenAt / manuallyFrozen
   * freeze state. @see docs/plans/v0.7-session-persistence.md §Task 4.2
   */
  // `| undefined` (not just `?`) so ThreadView can forward a possibly-absent
  // `draftThreadMap[id]` lookup directly under `exactOptionalPropertyTypes`.
  initialDraft?: string | undefined
  /**
   * Reports the live draft text up whenever it changes — App keys it by the
   * thread root id and write-throughs it to `composer.draft.thread.v1`
   * (debounced). NOT called on the initial mount (skip-first): the seeded value
   * must not echo back to disk. Text only — App closes over the root id.
   * @see src/renderer/src/App.tsx §draftThreadMap
   */
  onDraftChange?: ((text: string) => void) | undefined
  /**
   * Called once `onPost` has RESOLVED, so App drops this root's entry from the
   * draft map. Never fires on a no-op submit, on a rejected post, or when the
   * textarea still holds live text the user typed mid-flight — the persisted
   * entry and the on-screen draft are cleared together or not at all.
   */
  onDraftClear?: (() => void) | undefined
}

/** @see ThreadComposerProps */
export function ThreadComposer({
  livePlayhead,
  duration = null,
  pendingFrame = null,
  onPost,
  onManualSeekEntry,
  onCapture,
  error = null,
  onClearError,
  initialDraft = '',
  onDraftChange,
  onDraftClear,
}: ThreadComposerProps) {
  // ── local state ────────────────────────────────────────────────────────────
  const [draft, setDraft] = useState(initialDraft)
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
  /**
   * True when this draft has NO timestamp anchor — posts land as anchorless
   * (untimestamped) comment-notes. Only a RESTORED draft (non-empty
   * `initialDraft`) starts anchorless: v0.7 persists ONLY the draft text, never
   * the chip's frozenAt, so at restore the anchor would otherwise freeze at the
   * mount-time livePlayhead (≈0:00 on a fresh restart) — a wrong anchor. A
   * freshly-typed draft (empty initialDraft) is NEVER anchorless. The user exits
   * anchorless by committing a manual time via the chip (see commitChipInput).
   * @see docs/plans/v0.7-session-persistence.md §Task 4.2
   */
  const [anchorless, setAnchorless] = useState((initialDraft ?? '').trim().length > 0)
  // Whether the chip manual-entry input is open.
  const [chipEditing, setChipEditing] = useState(false)
  const [chipInputValue, setChipInputValue] = useState('')

  // Auto-grow textarea via the shared hook (also used by Composer +
  // SimpleComposer). Mirrors the prior inline useLayoutEffect.
  const textareaRef = useAutoGrowTextarea(draft)

  // `draft` as of the latest keystroke. `submit()` awaits, so its closed-over
  // `draft` is stale by the time the post resolves; this ref is what the
  // clobber check reads. Written only where `setDraft` is (onChange + the
  // success clear), never during render.
  const draftRef = useRef(initialDraft)
  // Double-submit guard (Enter held, double-click). A ref, not state: it must
  // flip on the SAME stack as the first keydown, before any await. A second
  // `notes.create` for the same body is itself a duplicate-slug throw.
  const inFlight = useRef(false)

  // Report the live draft text up (v0.7 Task 4.2 persistence). ONLY the text —
  // never the chip/frozenAt/manuallyFrozen freeze state. Skip-first is expressed
  // as "differs from the seed" rather than a boolean flag so it survives
  // StrictMode's dev double-invoke of mount effects (both invokes see draft ===
  // the seed → no report). Mirrors Composer.tsx's reporter.
  // @see src/renderer/src/composer/Composer.tsx §onDraftChange
  const lastReported = useRef(initialDraft)
  useEffect(() => {
    if (lastReported.current === draft) return
    lastReported.current = draft
    onDraftChange?.(draft)
  }, [draft, onDraftChange])

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

  // ── submit ────────────────────────────────────────────────────────────────
  // Clear-on-success (#176): every post-submit update below sits AFTER the
  // await, on the resolve path only. Deferring all five together is what makes
  // a retry safe — `chipTime` returns `frozenAt` unless `!focused && !hasDraft`
  // (composer-chip.ts:40) and the freeze effect's deps are
  // `[focused, hasDraft, manuallyFrozen]`, so with nothing cleared the draft
  // stays → `hasDraft` stays true → no dep moves → `frozenAt` is preserved →
  // the RETRY POSTS THE SAME `t`. Re-anchoring a retry to a different second is
  // a second, subtler data-loss bug. `pendingFrame` needs no handling here:
  // ThreadView clears it in the mutation's `onSuccess`.
  const submit = async () => {
    // FIX 4: allow an empty-caption post when a pending frame is present —
    // the screenshot IS the content. A truly empty post (no draft, no frame)
    // is still a no-op.
    if ((!hasDraft && !pendingFrame) || inFlight.current) return
    // FIX 3: when a frame is pending the post MUST anchor to the capture
    // moment (pendingFrame.t), not the live chip time — they can differ.
    // Using the same value for both the chip display and onPost keeps them
    // consistent from the user's perspective.
    // Anchor precedence: a captured frame ALWAYS wins (explicit anchor, carries
    // its own t) → else an anchorless (restored) draft posts with t: null → else
    // the live/frozen chip time. See `anchorless` state + FIX B.
    const t: number | null = pendingFrame
      ? pendingFrame.t
      : anchorless
        ? null
        : chipTime({ focused: effectiveFocused, hasDraft, livePlayhead, frozenAt })
    // What the clobber guard compares against. The post itself still carries the
    // UNTRIMMED `draft` (unchanged by v0.8.2) — only the comparison is
    // normalized, so a stray space typed mid-flight still counts as unchanged.
    const trimmed = draft.trim()
    inFlight.current = true
    try {
      await onPost({ body: draft, t })
    } catch {
      // A failed post clears NOTHING. The error surface is the parent's `error`
      // prop, fed by ThreadView's `postError`; catching here only stops the
      // rejection from going unhandled.
      return
    } finally {
      inFlight.current = false
    }
    // Clobber guard: the post took a real IPC round-trip, so the user may have
    // typed since. Reset only if the textarea still trims to what was sent —
    // otherwise the visible draft, the persisted entry AND the freeze state all
    // keep serving the newer text, and they stay in agreement.
    if (draftRef.current.trim() !== trimmed) return
    draftRef.current = ''
    setDraft('')
    // Drop this root's persisted draft (Task 4.2 clear-and-cancel), in lockstep
    // with the local clear — never one without the other.
    onDraftClear?.()
    setManuallyFrozen(false)
    // Reset anchorless so the NEXT fresh note is normally-anchored (live chip).
    setAnchorless(false)
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
      void submit()
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
      // Adding a manual time converts a restored (anchorless) draft to anchored.
      setAnchorless(false)
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
        border: `1px solid ${error ? 'var(--status-wtf)' : 'var(--border-1)'}`,
        borderRadius: 'var(--r-4)',
        boxShadow: 'var(--shadow-2)',
        padding: '7px 9px',
      }}
    >
      {/* Pending frame — rendered via AnnotatedFrame so a frame annotated in the
          capture-time editor shows its overlay in the chip (v0.2.5). */}
      {pendingFrame != null && (
        <div style={{ marginBottom: 7 }}>
          <AnnotatedFrame attachment={pendingFrame.attachment} />
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
            // formatClock for display) and cap at 6 digits → H:MM:SS. Live-clamp
            // to the video length AS you type: once entry exceeds the end we store
            // the clamped value's digits, so hammering 9999 freezes at the duration
            // (e.g. 3:24 video → 3:24) instead of silently overshooting.
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, '').slice(0, 6)
              const secs = parseTimeDigits(digits)
              const clamped = clampSeconds(secs, duration)
              setChipInputValue(clamped < secs ? formatClock(clamped).replace(/\D/g, '') : digits)
            }}
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
            // Anchorless (restored) draft with no captured frame: show an
            // "add time" affordance instead of a bogus clock (the original
            // timestamp isn't persisted). Clicking still opens the chip input,
            // and committing a time converts the draft to anchored. FIX B.
            title={
              anchorless && !pendingFrame
                ? 'no timestamp — click to add an anchor time'
                : 'click to edit anchor time — type digits, e.g. 1234 → 12:34'
            }
            aria-label={anchorless && !pendingFrame ? 'add anchor time' : 'anchor time'}
            onClick={openChipInput}
            style={{ ...inlineTimeStyle, border: 0, cursor: 'pointer' }}
          >
            {anchorless && !pendingFrame ? '+ time' : displayTime}
          </button>
        )}

        {/* Auto-grow textarea — starts at one line, grows as you type */}
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          onChange={(e) => {
            if (error) onClearError?.()
            draftRef.current = e.target.value
            setDraft(e.target.value)
          }}
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

        <SendButton
          onClick={() => {
            void submit()
          }}
          label="post note"
          title="post note ↵"
        />
      </div>

      {error && (
        <div
          role="alert"
          style={{
            marginTop: 6,
            color: 'var(--status-wtf)',
            fontSize: 12,
            lineHeight: 1.4,
          }}
        >
          {error}
        </div>
      )}
    </div>
  )
}
