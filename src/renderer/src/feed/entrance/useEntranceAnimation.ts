import { getFeedEntrance } from '../../lib/anim-pref'
import { useGlideReveal } from './glideReveal'
import type { EntranceCtx } from './types'
import { useWaveReveal } from './waveReveal'

/**
 * Feed-facing entrance dispatcher. Reads the active {@link FeedEntrance} pref per render
 * (snapshot below) and routes the append to the matching runner: `glide` →
 * {@link useGlideReveal} (the scroll-glide), `flip`/`pbd` → {@link useWaveReveal} (the
 * shared wave engine, `pbd` adds the non-overlap projection).
 *
 * BOTH runners are always called — Rules of Hooks forbid conditional hooks — and each is
 * gated by an `enabled` flag so only the selected strategy acts; the others early-return in
 * their append effect. `enabled` lives in each effect's dependency array, so flipping the
 * pref between renders re-evaluates the gate. An in-flight animation finishes; a pref change
 * applies from the NEXT send (no mid-wave cancel — see spec §Risks).
 *
 * The Feed owns the follow-suppression state (`waveSettling`) and computes `suppressFollow`
 * itself above `useVirtualizer`; the dispatcher only forwards the setters a runner needs
 * (`setWaveSettling` for the wave, `revealingRef`/`setRevealing`/`suppressThumbResizeRef`
 * for glide). `sendInFlight` is folded into `suppressFollow` by the Feed, not here.
 * @see docs/specs/v0.2.2-repulsion-wave.md §Architecture, §The Guard
 */
export function useEntranceAnimation(ctx: EntranceCtx & { sendInFlight: boolean }): void {
  // Snapshot the pref per render; the runners' effects read `enabled` from their deps, so a
  // pref change re-evaluates the gate on the next render (per-send selection).
  const entrance = getFeedEntrance()

  useGlideReveal({
    virtualizer: ctx.virtualizer,
    scrollerEl: ctx.scrollerEl,
    notes: ctx.notes,
    revealingRef: ctx.revealingRef,
    setRevealing: ctx.setRevealing,
    suppressThumbResizeRef: ctx.suppressThumbResizeRef,
    enabled: entrance === 'glide',
  })

  useWaveReveal({
    virtualizer: ctx.virtualizer,
    scrollerEl: ctx.scrollerEl,
    notes: ctx.notes,
    revealingRef: ctx.revealingRef,
    setRevealing: ctx.setRevealing,
    suppressThumbResizeRef: ctx.suppressThumbResizeRef,
    setWaveSettling: ctx.setWaveSettling,
    model: entrance === 'pbd' ? 'pbd' : 'flip',
    enabled: entrance !== 'glide',
  })
}
