import { useGlideReveal } from './glideReveal'
import type { EntranceCtx } from './types'

/**
 * Feed-facing entrance dispatcher. Batch 1: glide always runs (it self-gates on
 * append + reduced-motion + at-end). Task 9 routes flip/pbd to the wave engine and
 * gates glide on the pref. The Feed owns the follow-suppression state (waveSettling)
 * and computes `suppressFollow` itself — the dispatcher only forwards setters.
 * `setWaveSettling`/`sendInFlight` are accepted now to freeze the call-site signature;
 * Task 9's wave runner consumes them.
 * @see docs/specs/v0.2.2-repulsion-wave.md §Architecture
 */
export function useEntranceAnimation(ctx: EntranceCtx & { sendInFlight: boolean }): void {
  useGlideReveal({
    virtualizer: ctx.virtualizer,
    scrollerEl: ctx.scrollerEl,
    notes: ctx.notes,
    revealingRef: ctx.revealingRef,
    setRevealing: ctx.setRevealing,
    suppressThumbResizeRef: ctx.suppressThumbResizeRef,
  })
}
