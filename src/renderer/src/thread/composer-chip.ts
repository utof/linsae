/**
 * Composer chip — pure freeze/resume state machine for the playback-anchor chip.
 *
 * The chip shows the video second that anchors an in-progress comment. It:
 *   • LIVE-TRACKS the playhead when the composer is unfocused AND the draft is empty.
 *   • FREEZES at the live playhead the moment the user focuses the textarea, or on
 *     the first keystroke while empty; then stays frozen while they type.
 *   • RESUMES live-tracking (and resets frozenAt to the live value) when the user
 *     blurs + clears the draft (Esc / deletes all text).
 *
 * Design contract (no React / no DOM — pure functions only):
 *   • `chipTime`     → what to display.
 *   • `nextFrozenAt` → what to store; call on every (focused, hasDraft, livePlayhead) change.
 *
 * Why pure: the UI component can drive these from `useEffect` / inline derivation
 * without coupling the logic to render lifecycle details. Tests verify the four
 * cases (live / freeze / stay-frozen / resume) independently of any DOM.
 *
 * @see docs/specs/v0.2-youtube-annotation.md §Composer
 */

/**
 * The seconds the chip should DISPLAY.
 *
 * Live-tracks the playhead only when both `focused` and `hasDraft` are false;
 * otherwise shows the frozen capture value (`frozenAt`).
 *
 * Why: showing the live value while typing would be misleading — the user
 * chose a moment to annotate; we must anchor to that moment until they
 * explicitly release (Esc / clear).
 *
 * @see docs/specs/v0.2-youtube-annotation.md §Composer
 */
export function chipTime(s: {
  focused: boolean
  hasDraft: boolean
  livePlayhead: number
  frozenAt: number
}): number {
  return !s.focused && !s.hasDraft ? s.livePlayhead : s.frozenAt
}

/**
 * The next `frozenAt` value to store in component state.
 *
 * Rules (applied in priority order):
 *   1. `focused && !hasDraft` (focus just gained, or Esc cleared the draft while
 *      still focused): capture `livePlayhead` — this is the freeze moment.
 *   2. `focused && hasDraft` (typing is in progress): keep `prev` — do not
 *      re-capture mid-typing; the user anchored at focus time.
 *   3. `!focused && !hasDraft` (blur + empty, i.e. "live" state): update to
 *      `livePlayhead` so the NEXT focus event captures a fresh position rather
 *      than a stale one.
 *   4. `!focused && hasDraft` (should not occur in normal UX — blur with draft
 *      still set): keep `prev` for safety.
 *
 * The component calls this on every relevant state change; the returned value
 * replaces `frozenAt` in state.
 *
 * Why: keeping `frozenAt` fresh while live (case 3) means a re-focus event
 * always captures the current playhead, not the playhead from the previous
 * editing session.
 *
 * @see docs/specs/v0.2-youtube-annotation.md §Composer
 */
export function nextFrozenAt(
  prev: number,
  s: { focused: boolean; hasDraft: boolean; livePlayhead: number },
): number {
  if (s.focused && s.hasDraft) {
    // Typing in progress — keep the moment that was captured at focus time.
    return prev
  }
  if (!s.focused && s.hasDraft) {
    // Blur with draft present (unusual path) — keep prev for safety.
    return prev
  }
  // Both remaining cases — `focused && !hasDraft` (freeze) and
  // `!focused && !hasDraft` (live) — should track the live playhead:
  //   • freeze case: capture the current position as the anchor.
  //   • live case: keep frozenAt fresh so the next freeze is accurate.
  return s.livePlayhead
}
